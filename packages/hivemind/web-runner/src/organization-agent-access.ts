import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { authenticatedActorFromSource, type AuthenticatedActor } from '@deepseek-ai/dsh-hivemind-execution-scope'
/** Fresh server-derived organization agent authority. Never replace the human
 * principal with storageUserId: connected accounts remain owned by the actor. */
export interface OrganizationAgentAccess {
  readonly actor: { readonly userId: string; readonly orgId: string; readonly role: 'owner' | 'admin'; readonly name: string }
  readonly agent: { readonly orgId: string; readonly runtimeSessionId: string | null; readonly storageUserId: string }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const session = /^session-[a-z0-9-]{1,120}$/u
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

export async function resolveOrganizationAgentAccess(base: string, token: string,
  expected: { readonly orgId: string; readonly userId: string }, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch): Promise<OrganizationAgentAccess> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(3000)])
  const response = await fetchImpl(`${base}/internal/v1/harness-chat/core/organization-agent-access`, {
    headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: bounded,
  })
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel()
    throw new Error('organization_agent_access_denied')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let input: unknown
  try {
    while (true) {
      bounded.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 4096) throw new Error('organization_agent_access_invalid')
      chunks.push(chunk.value)
    }
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
  if (!record(input) || input['contract'] !== 'hivemind.organization-agent-access.v1'
    || input['access'] !== 'read-write' || !record(input['actor']) || !record(input['agent'])) throw new Error('organization_agent_access_invalid')
  const actor = input['actor'], agent = input['agent']
  if (actor['authority'] !== 'authenticated-profile' || actor['org_id'] !== expected.orgId
    || actor['user_id'] !== expected.userId || agent['org_id'] !== expected.orgId
    || !uuid.test(expected.orgId) || !uuid.test(expected.userId)
    || !['owner', 'admin'].includes(String(actor['role'])) || typeof actor['name'] !== 'string' || actor['name'].length > 180
    || typeof agent['storage_user_id'] !== 'string' || !uuid.test(agent['storage_user_id'])
    || (agent['runtime_session_id'] !== null && (typeof agent['runtime_session_id'] !== 'string' || !session.test(agent['runtime_session_id'])))) throw new Error('organization_agent_access_invalid')
  return Object.freeze({
    actor: Object.freeze({ userId: expected.userId, orgId: expected.orgId, role: actor['role'] as 'owner' | 'admin', name: actor['name'] }),
    agent: Object.freeze({ orgId: expected.orgId, runtimeSessionId: agent['runtime_session_id'], storageUserId: agent['storage_user_id'] }),
  })
}

/** A newly admitted trigger owns its turn; continuation steps retain that actor.
 * Never consult a later queued chat message for current-turn authority. */
export function currentTurnActor(
  messages:readonly { source:unknown }[], continuation:AuthenticatedActor | undefined,
  sameTurn=messages.length===0,
):AuthenticatedActor | undefined {
  const direct=messages.filter(message=>record(message.source)&&message.source['kind']==='user')
    .map(message=>authenticatedActorFromSource(message.source)).filter(value=>value!==undefined).at(-1)
  return direct ?? (sameTurn ? continuation : undefined)
    ?? messages.map(message=>authenticatedActorFromSource(message.source)).filter(value=>value!==undefined).at(-1)
}

/** Only a same-turn same-actor witness survives nonhuman inbox/context updates. */
export function retainAdmittedUserWitness(
  previous:{ id:string;actor:AuthenticatedActor }|undefined,actor:AuthenticatedActor,sameTurn:boolean,
):{ id:string;actor:AuthenticatedActor }|undefined {
  return sameTurn && previous?.actor.userId===actor.userId && previous.actor.orgId===actor.orgId ? previous : undefined
}

/** Session-bound RPC identifiers, including persisted workspace files. */
export function referencedSessionIds(value: unknown, depth = 0, ids = new Set<string>()): Set<string> {
  if (depth > 8 || value === null || typeof value !== 'object') return ids
  if (Array.isArray(value)) {
    for (const item of value) referencedSessionIds(item, depth + 1, ids)
    return ids
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'agentId' || key === 'sessionId' || key === 'parentSessionId' || key === 'childSessionId' || key === 'workspaceFileScopeId')
      && typeof item === 'string' && item.length > 0) ids.add(item)
    else referencedSessionIds(item, depth + 1, ids)
  }
  return ids
}

/** Bind a call reconciliation to its exact persisted receipt, never a later call. */
export function admittedVoiceCallRef(
  messages:readonly { source:unknown }[],events:readonly { type:string;data:unknown }[],actor:AuthenticatedActor,
):string|undefined {
  const source=messages.map(message=>message.source).findLast(value=>record(value)&&value['kind']==='plugin'
    &&value['plugin']==='hivemind-live-voice'&&authenticatedActorFromSource(value)?.userId===actor.userId)
  if(!record(source)||typeof source['voiceCallId']!=='string') return undefined
  const callId=source['voiceCallId']
  const found=events.some(event=>event.type==='hivemind/voice-call-ended'&&record(event.data)&&event.data['callId']===callId
    &&event.data['hadUserSpeech']===true&&record(event.data['authenticatedActor'])
    &&event.data['authenticatedActor']['userId']===actor.userId&&event.data['authenticatedActor']['orgId']===actor.orgId)
  return found?`call:${callId}`:undefined
}

/** A native admitted user message is appended only after pre-step returns. */
export function admittedUserConfirmationRef(
  events:readonly { type:string;seq:number;data:unknown }[],id:string|undefined,actor:AuthenticatedActor,
):string|undefined {
  if(!id) return undefined
  const event=events.find((event)=>{
    if(event.type!=='user/message'||!record(event.data)||event.data['id']!==id) return false
    const source=event.data['source'];const author=authenticatedActorFromSource(source)
    return record(source)&&source['kind']==='user'&&author?.userId===actor.userId&&author.orgId===actor.orgId
  })
  return event?`event:${event.seq}`:undefined
}

/** The tool boundary flushes through native SessionStore before Core validation. */
export const runtimeWitnessServices=['tools','sessions'] as const

/** Persisted model context from the current admitted actor, never a later queued user. */
export function authenticatedInitiatorMessage(actor: AuthenticatedActor) {
  return createUserMessage({
    source: { kind: 'plugin', plugin: 'hivemind-web-runner/authenticated-initiator', form: 'recall', authenticatedActor: actor },
    content: [{ type: 'text', text: `Server-authenticated initiating user for this work: ${JSON.stringify(actor)}. Use this authenticated profile name when acknowledging the sender. This identifies who initiated the work; it does not grant additional permissions or change company goals.` }],
  })
}

export function withAuthenticatedInitiator(decision: PreStepDecision, actor: AuthenticatedActor, admitted: boolean): PreStepDecision {
  if(decision.kind==='reject' || !admitted) return decision
  return { ...decision, messages:[authenticatedInitiatorMessage(actor),...decision.messages.filter(message=>
    !(message.source.kind==='plugin' && message.source.plugin==='hivemind-web-runner/authenticated-initiator'))] }
}
