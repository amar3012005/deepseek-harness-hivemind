import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

interface DiagnosticEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** Filter immutable receipts, including shadowed history; memory is not evidence. */
export function sessionDiagnostics(
  events: readonly DiagnosticEvent[], since: number, until: number, after: number, limit: number,
): Record<string, JsonValue> {
  const calls = new Map<string, { name: string; turn?: number }>()
  const failures: JsonValue[] = []
  let next = after
  let more = false
  let inspected = 0
  for (const event of events) {
    const data = event.data as Record<string, unknown>
    if (event.type === 'tool/call' && typeof data.callId === 'string') {
      calls.set(data.callId, { name: String(data.name), ...(typeof data.turn === 'number' ? { turn: data.turn } : {}) })
    }
    if (event.time < since || event.time >= until || event.seq <= after) continue
    inspected++
    let failure: Record<string, JsonValue> | undefined
    const message = data.message as { source?: { callId?: string }; content?: { isError?: boolean; content?: unknown }[] } | undefined
    if (event.type === 'tool/result') {
      const errors = message?.content?.filter(block => block.isError === true) ?? []
      if (errors.length) {
        const call = calls.get(message?.source?.callId ?? '')
        failure = { kind: 'tool_result', tool: call?.name ?? 'unknown', observed: errors.map(block => typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).join('\n').slice(0, 1200) }
      }
    } else if (event.type === 'turn/end') {
      const reason = data.reason as { kind?: string; error?: unknown } | undefined
      if (reason?.kind === 'error') failure = { kind: 'turn_error', observed: JSON.stringify(reason.error).slice(0, 1200) }
    } else if (event.type === 'compaction/end' && data.error !== undefined) {
      failure = { kind: 'compaction_error', observed: String(data.error).slice(0, 1200) }
    }
    if (!failure) continue
    if (failures.length >= limit) { more = true; break }
    next = event.seq
    failures.push({ ...failure, sequence: event.seq, time: new Date(event.time).toISOString(), ...(typeof data.turn === 'number' ? { turn: data.turn } : {}) })
  }
  return { source: 'own_immutable_session_log', since: new Date(since).toISOString(), until: new Date(until).toISOString(), inspected_events: inspected, failures, has_more: more, next_sequence: next,
    evidence_note: 'These are actual recorded failures, not recalled memories. Raw errors remain private; redact business data and credentials before sharing. No failures proves only this session and window were inspected. Other logs, task blockers and performance require their own receipts.' }
}

/** Read-only native own-session filter shared by Runtime and persistent employees. */
export function sessionDiagnosticsTool() {
  return defineTool({
    name: 'hyperagents_session_diagnostics',
    description: 'Inspect YOUR OWN immutable session receipts in an exact UTC time window, including errors hidden by compaction. Returns failed tool results, model/turn failures and compaction failures with original sequence/turn. Do this before nightly error reporting; private-memory recall is not an error log. Does not read other agents, change state, retry work or send raw errors externally. Paginate with after_sequence when has_more.',
    parameters: {
      since: { type: 'string', required: true, description: 'Inclusive UTC RFC3339 window start.' },
      until: { type: 'string', required: true, description: 'Exclusive UTC RFC3339 window end; at most 7 days after since.' },
      after_sequence: { type: 'integer', description: 'Previous next_sequence for pagination; default 0.' },
      limit: { type: 'integer', description: '1–50 failures per page; default 25.' },
    },
    isConcurrencySafe: () => true,
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      const agent: Agent | undefined = execution.agent
      if (!agent) throw Error('session_diagnostics_agent_required')
      const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u
      const since = Date.parse(args.since), until = Date.parse(args.until)
      const after = args.after_sequence ?? 0, limit = args.limit ?? 25
      if (!utc.test(args.since) || !utc.test(args.until) || !Number.isFinite(since) || !Number.isFinite(until) || until <= since || until - since > 7 * 86_400_000 || !Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('session_diagnostics_invalid_window_or_page')
      return sessionDiagnostics(agent.session.snapshotEvents(), since, until, after, limit)
    },
  })
}

/** Register the native tool without introducing another log or observer. */
export function installSessionDiagnostics(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(sessionDiagnosticsTool()))
}
