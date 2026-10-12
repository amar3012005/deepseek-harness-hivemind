/** One trusted per-turn router for Runtime's progressive lifecycle skills. */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { questionRespondentWitnessForReply } from '@deepseek-ai/dsh-hivemind-execution-scope'
import { runtimeLifecycleStageSkillNames } from './lifecycle-stage-skills.ts'
import type { RuntimeLifecycleStageId } from './lifecycle-stage-skills.ts'
import { runtimeUniversalPolicy } from './lifecycle-stage-skills.ts'

export interface RuntimeStageHints {
  /** Derived only from the host's awakening transition. */
  readonly awakening?: boolean
  /** Must be computed by isNightlyScheduledTurn(agent, admitted) in the host router. */
  readonly nightly?: boolean
}

export interface RuntimeStagePlan {
  readonly stages: readonly RuntimeLifecycleStageId[]
  readonly skillNames: readonly string[]
}

/**
 * The existing agent/pre-step router calls this once after native admission.
 * Only current-turn typed sources and host-verified transition hints select a
 * stage. It returns names for trusted ctx.skills.get() loading; names are not
 * a request for the model to optionally invoke a skill.
 */
export function selectRuntimeStagePlan(
  events: readonly SessionEvent[],
  admitted: readonly UserMessage[],
  sessionId: string,
  hints: RuntimeStageHints = {},
): RuntimeStagePlan {
  const boundary = events.findLast(event => event.type === 'turn/start')?.seq ?? -1
  const current = [
    ...events.flatMap(event => event.seq > boundary && event.type === 'user/message' ? [event.data] : []),
    ...admitted,
  ]
  const stages = new Set<RuntimeLifecycleStageId>()
  if (hints.awakening) stages.add('awakening')

  // Exact protected occurrence predicate is evaluated by the single host router.
  // A Nightly turn suppresses all ordinary schedule/employee routing.
  if (hints.nightly) {
    stages.add('nightly-reconciliation')
    return stagePlan(stages)
  }

  // Saved host/plugin transitions are the stage identifier. Text that claims
  // delegation or approval cannot create one.
  if (events.some((event) => {
    const saved = eventRecord(event)
    if (saved.seq <= boundary || saved.type !== 'hivemind/employee-delegation-start') return false
    const parentRun = saved.data['parentRun']
    return typeof parentRun === 'object' && parentRun !== null
      && (parentRun as Record<string, unknown>)['sessionId'] === sessionId
  })) stages.add('delegation')
  if (events.some((event) => {
    const saved = eventRecord(event)
    return saved.seq > boundary && saved.type === 'hivemind/hq-rest-confirmed'
  })) stages.add('rest-sleep')
  if (hasVerifiedAllowedApproval(events, boundary)) stages.add('approval-or-blocker-resume')

  for (const input of current) {
    const source = sourceRecord(input.source)
    if (voiceCallFollowup(events, source)) stages.add('voice-call-reconciliation')
    if (source.kind === 'schedule') stages.add('scheduled-wake')
    if (source.kind === 'hivemind-runtime-event') stages.add('attention-signal')
    if (source.kind === 'subagent-settled') stages.add('agent-result-review')
    if (source.kind === 'user-question-reply' && verifiedAnswer(events,boundary,source)) {
      stages.add('approval-or-blocker-resume')
    }
    if (source.kind === 'hivemind-agent-message') {
      const receipt = events.findLast((event) => {
        const saved = eventRecord(event)
        return saved.type === 'hivemind/room-message-received'
          && saved.data['id'] === source.messageId && saved.data['senderId'] === source.senderId
          && saved.data['targetId'] === sessionId
      })
      const data = receipt === undefined ? undefined : eventRecord(receipt).data
      if (data && (typeof data['taskId'] === 'string'
        || (Array.isArray(data['artifactIds']) && data['artifactIds'].length > 0))) {
        stages.add('agent-result-review')
        stages.add('approval-or-blocker-resume')
      }
    }
  }

  const accessReady = events.some((event) => {
    const saved = eventRecord(event)
    return saved.seq > boundary && saved.type === 'hivemind/connected-receipt'
      && receiptReady(saved.data['receipt'])
  })
  if (accessReady) stages.add('approval-or-blocker-resume')
  return stagePlan(stages)
}

function stagePlan(stages: ReadonlySet<RuntimeLifecycleStageId>): RuntimeStagePlan {
  const ordered = [...stages]
  return { stages: ordered, skillNames: ordered.map(stage => runtimeLifecycleStageSkillNames[stage]) }
}

/** Answer sources have to correlate to a tool call saved in this exact room. */
function verifiedAnswer(
  events: readonly SessionEvent[],boundary:number,
  source: Record<string, unknown>,
): boolean {
  if(source['outcome']!=='answered'||typeof source['callId']!=='string')return false
  const replies=events.filter(event=>event.seq>boundary&&event.type==='user/message'
    &&String(Reflect.get(event.data.source,'kind'))==='user-question-reply'&&Reflect.get(event.data.source,'callId')===source['callId'])
  if(replies.length!==1)return false
  const reply=replies[0]
  return reply!==undefined&&questionRespondentWitnessForReply(events,reply)!==undefined
}

/** Pair the current-turn allowed-once decision to its asked id and exact tool call. */
function hasVerifiedAllowedApproval(events: readonly SessionEvent[], boundary: number): boolean {
  const saved = events.map(eventRecord)
  return saved.some((decision) => {
    if (decision.seq <= boundary || decision.type !== 'approval/decided'
      || decision.data['outcome'] !== 'allowed-once' || typeof decision.data['id'] !== 'string') return false
    const asked = saved.find(item => item.seq > boundary && item.type === 'approval/asked'
      && item.data['id'] === decision.data['id'])
    if (!asked || typeof asked.data['callId'] !== 'string' || typeof asked.data['toolName'] !== 'string') return false
    return saved.some(item => item.type === 'tool/call' && item.data['callId'] === asked.data['callId']
      && item.data['name'] === asked.data['toolName'])
  })
}

function receiptReady(receipt: unknown): boolean {
  return receipt !== null && typeof receipt === 'object' && 'status' in receipt && receipt.status === 'ready'
}

/** Require the producer's typed voice-call provenance, authenticated
 * administrator, and same-actor durable ended-call receipt. */
function voiceCallFollowup(events: readonly SessionEvent[], value: Record<string, unknown>): boolean {
  const actor = value['authenticatedActor'] as { userId?: unknown; orgId?: unknown; role?: unknown } | undefined
  if (value['kind'] !== 'hivemind-live-voice' || value['plugin'] !== 'hivemind-live-voice'
    || value['form'] !== 'recall'
    || typeof value['voiceCallId'] !== 'string'
    || !actor || !['owner', 'admin'].includes(String(actor.role))) return false
  return events.some((event) => {
    const saved = eventRecord(event)
    const receiptActor = saved.data['authenticatedActor'] as typeof actor | undefined
    return saved.type === 'hivemind/voice-call-ended'
      && saved.data['callId'] === value['voiceCallId']
      && receiptActor?.userId === actor.userId
      && receiptActor?.orgId === actor.orgId
      && receiptActor?.role === actor.role
  })
}

function sourceRecord(source: UserMessage['source']): Record<string, unknown> & { kind: string } {
  return source as unknown as Record<string, unknown> & { kind: string }
}

function eventRecord(event: SessionEvent): { type: string; seq: number; data: Record<string, unknown> } {
  const saved = event as unknown as { type: string; seq: number; data: unknown }
  const data = typeof saved.data === 'object' && saved.data !== null
    ? saved.data as Record<string, unknown> : {}
  return { type: saved.type, seq: saved.seq, data }
}

/** Compatibility for callers while the host router is migrated to explicit
 * native skill loading. This contains no all-stage procedural prompt. */
export function runtimeStageGuidance(
  events: readonly SessionEvent[],
  admitted: readonly UserMessage[],
  sessionId: string,
  awakening: boolean,
  nightly: boolean,
): string {
  const plan = selectRuntimeStagePlan(events, admitted, sessionId, { awakening, nightly })
  return `${runtimeUniversalPolicy}\nAuthenticated stage skill names for scoped loading: ${plan.skillNames.join(', ') || 'none'}.`
}
