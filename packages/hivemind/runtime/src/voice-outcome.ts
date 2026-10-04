/** The native reasoning turn assesses baseline completeness from a saved same-room transcript. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'hivemind/voice-call-ended': { callId: string; provider: 'codex' | 'grok'; initialCheckIn: boolean; interrupted: boolean; hadUserSpeech: boolean; transcript: string }
    'hivemind/voice-baseline-outcome': { callId: string; status: 'complete' | 'incomplete'; summary: string; remaining: string[] }
  }
}
/** Validate the actual saved call instead of duration or a transcript keyword. */
export function validateVoiceOutcome(agent: Agent, callId: string, status: string) {
  const call = agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/voice-call-ended' && event.data.callId === callId)
  if (call?.type !== 'hivemind/voice-call-ended' || !call.data.initialCheckIn || !call.data.transcript.trim()) throw new Error('baseline_call_receipt_required')
  if (status === 'complete' && (call.data.interrupted || !call.data.hadUserSpeech)) throw new Error('interrupted_baseline_remains_pending')
  return call.data
}
/** Small native tool; Runtime decides the outcome, the receipt only validates provenance. */
export function installVoiceOutcome(ctx: Context) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_voice_baseline',
    description: 'Record your assessment of a saved initial Runtime voice check-in. Read its exact voice-call-ended receipt. Complete only when the administrator established or explicitly left unknown the needed baseline or explicitly left unknown current company status, actual offer, sales, niche and go-to-market; no separate growth objective is required. Aborted or interrupted calls remain incomplete. Cite exact call_id; preserve uncertainty and remaining discussion in summary/remaining. No task, memory publication or schedule is authorized by this receipt.',
    parameters: {
      call_id: { type: 'string', required: true, description: 'Exact saved same-room voice call ID.' },
      status: { type: 'string', enum: ['complete', 'incomplete'], required: true },
      summary: { type: 'string', required: true, description: 'Concise evidence-based assessment.' },
      remaining: { type: 'array', items: { type: 'string' }, description: 'Unresolved baseline questions; unknown fields remain unknown.' },
    },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      const agent = execution.agent
      if (!agent || agent.session.header.agentPreset !== 'hivemind-hq') throw new Error('runtime_voice_room_required')
      const callId = typeof args.call_id === 'string' ? args.call_id : ''
      const status = args.status
      if (!/^[0-9a-f-]{36}$/i.test(callId) || (typeof status !== 'string' || !['complete', 'incomplete'].includes(status))) throw new Error('invalid_baseline_outcome')
      const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
      const remaining = Array.isArray(args.remaining) ? args.remaining : []
      if (args.remaining !== undefined && !Array.isArray(args.remaining)) throw new Error('invalid_baseline_assessment')
      if (!summary || summary.length > 2000 || remaining.length > 20 || remaining.some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) throw new Error('invalid_baseline_assessment')
      validateVoiceOutcome(agent, callId, String(status))
      const existing = agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/voice-baseline-outcome' && event.data.callId === callId)
      if (existing?.type === 'hivemind/voice-baseline-outcome') {
        if (JSON.stringify(existing.data) !== JSON.stringify({ callId, status, summary, remaining: remaining as string[] })) throw new Error('baseline_outcome_already_recorded')
        return { ...existing.data, saved: true }
      }
      agent.session.append('hivemind/voice-baseline-outcome', { callId, status: status as 'complete' | 'incomplete', summary, remaining: remaining as string[] })
      if (!(await ctx.sessions.flush(agent.session))) throw new Error('voice_outcome_persistence_required')
      return { callId, status, saved: true }
    },
  })))
}
