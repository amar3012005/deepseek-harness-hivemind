import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The first admitted turn pins this authenticated session's lead identity. */
export interface SessionOwner {
  id: string | null
  slug: string
  name: string
  role: string
  persona?: string | undefined
  avatarUrl?: string | undefined
}

/** Server-produced completion packet; models cannot supply or execute this action. */
export interface TaskMemoryRecord {
  action: 'record_task'
  agent_slug: string
  title: string
  summary: string
  idempotency_key: string
  run_id: string
  context: {
    source: 'dsh-turn'
    completionScope: 'response'
    sessionId: string
    turn: number
    ownerName: string
    requestedAt: string
    completedAt: string
    requestSeqs: number[]
    responseSeq: number
    completionSeq: number
    toolReceipts: Array<{ name: string; callId: string; resultSeq: number; isError: boolean }>
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Persistent employee identity that owns this agent session across reloads and later turns. */
    'hivemind/session-owner': SessionOwner
    /** Completed-task handoff awaiting its durable private HyperAgent memory receipt. */
    'hivemind/task-memory-pending': TaskMemoryRecord
    /** Confirmed private operating-memory receipt for a completed task handoff. */
    'hivemind/task-memory-recorded': { idempotencyKey: string; memoryId: string; turn: number }
  }
}

/** First owner wins even if a later selection or malformed reassignment exists. */
export function sessionOwner(events: readonly SessionEvent[]): SessionOwner | undefined {
  return events.find(event => event.type === 'hivemind/session-owner')?.data
}

/** Pending durable records are an outbox; successful receipts suppress replay. */
export function pendingTaskMemories(events: readonly SessionEvent[]): TaskMemoryRecord[] {
  const saved = new Set(events.filter(event => event.type === 'hivemind/task-memory-recorded').map(event => event.data.idempotencyKey))
  return events.flatMap(event => event.type === 'hivemind/task-memory-pending' && !saved.has(event.data.idempotency_key) ? [event.data] : [])
}

/** Record the delivered response, never infer an external action from assistant prose. */
export function completedTaskMemory(
  sessionId: string, owner: SessionOwner, events: readonly SessionEvent[], turn: number,
): TaskMemoryRecord | undefined {
  const end = events.findLast(event => event.type === 'turn/end' && event.data.turn === turn)
  const start = events.findLast(event => event.type === 'turn/start' && event.data.turn === turn)
  if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed' || start === undefined) return undefined
  const within = events.filter(event => event.seq > start.seq && event.seq < end.seq)
  const requests = within.filter(event => event.type === 'user/message' && (event.data.source.kind === 'user' || String(event.data.source.kind) === 'schedule'))
  const request = requests.map(event => event.type === 'user/message' ? event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '').join('\n').trim()
  const answer = within.findLast(event => event.type === 'assistant/message' && event.data.turn === turn && !event.data.interrupted && event.data.message.content.some(block => block.type === 'text' && block.text.trim() !== ''))
  if (request === '' || answer?.type !== 'assistant/message') return undefined
  const delivered = answer.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  const calls = new Map(within.filter(event => event.type === 'tool/call').map(event => [String(event.data.callId), event.data.name]))
  const toolReceipts = within.filter(event => event.type === 'tool/result').flatMap((event) => {
    if (event.type !== 'tool/result') return []
    const block = event.data.message.content[0]
    const callId = String(block.toolCallId)
    const name = calls.get(callId)
    return name === undefined ? [] : [{
      name: name.slice(0, 100), callId: callId.slice(0, 100), resultSeq: Number(event.seq), isError: block.isError === true,
    }]
  }).slice(-16)
  const idempotencyKey = `dsh-task:${sessionId}:${turn}:${end.seq}`
  const hash = createHash('sha256').update(idempotencyKey).digest('hex')
  const runId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  return {
    action: 'record_task', agent_slug: owner.slug,
    title: `Completed response: ${request}`.slice(0, 180),
    summary: `User requested: ${request.slice(0, 600)}\nDelivered response: ${delivered.slice(0, 1500)}\nEvidence: session ${sessionId}, turn ${turn}, response seq ${answer.seq}. This records response completion; external actions require their own successful tool receipts.`.slice(0, 2400),
    idempotency_key: idempotencyKey, run_id: runId,
    context: {
      source: 'dsh-turn', completionScope: 'response', sessionId, turn, ownerName: owner.name.slice(0, 180),
      requestedAt: new Date(requests[0]?.time ?? start.time).toISOString(), completedAt: new Date(end.time).toISOString(),
      requestSeqs: requests.slice(-64).map(event => Number(event.seq)),
      responseSeq: Number(answer.seq), completionSeq: Number(end.seq), toolReceipts,
    },
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    hyperagentOwner: string | null
    hyperagentSelection: string | null
    hyperagentLatestMessage: string | null
  }
  interface SessionProjectionStateMap {
    hyperagentOwner: SessionOwner | null
    hyperagentSelection: string | null
    hyperagentLatestMessage: string | null
  }
}

const ownerSchema = z.object({
  id: z.string().nullable(), slug: z.string(), name: z.string(), role: z.string(),
  persona: z.string().optional(), avatarUrl: z.string().optional(),
}).nullable()

/** Serve ownership independently of the paginated history window. */
export const sessionOwnerProjection = {
  key: 'hyperagentOwner', stateSchema: ownerSchema, stateVersion: 1,
  init: () => null,
  apply: (state, event) => state ?? (event.type === 'hivemind/session-owner' ? event.data : null),
  wire: {
    viewSchema: z.string().nullable(),
    view: state => state === null ? null : JSON.stringify({
      id: state.id, slug: state.slug, name: state.name, role: state.role,
      ...(state.avatarUrl ? { avatarUrl: state.avatarUrl } : {}),
    }),
  },
} satisfies ProjectionDefinition<'hyperagentOwner', SessionOwner | null>

/** A bounded user-facing message preview, independent of transcript pagination. */
export const employeeLatestMessageProjection = {
  key: 'hyperagentLatestMessage', stateSchema: z.string().nullable(), stateVersion: 1,
  init: () => null,
  apply: (state, event) => {
    if (event.type !== 'assistant/message' || event.data.interrupted) return state
    const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(' ').replace(/\s+/gu, ' ').trim()
    return text ? JSON.stringify({ text: text.slice(0, 160), time: event.time }) : state
  },
  wire: { viewSchema: z.string().nullable(), view: state => state },
} satisfies ProjectionDefinition<'hyperagentLatestMessage', string | null>

/** Editable employee selection for blank rooms, separate from pinned ownership. */
export const employeeSelectionProjection = {
  key: 'hyperagentSelection', stateSchema: z.string().nullable(), stateVersion: 1,
  init: () => null,
  apply: (state, event) => event.type === 'hivemind/employee-selection' ? JSON.stringify(event.data) : state,
  wire: { viewSchema: z.string().nullable(), view: state => state },
} satisfies ProjectionDefinition<'hyperagentSelection', string | null>
