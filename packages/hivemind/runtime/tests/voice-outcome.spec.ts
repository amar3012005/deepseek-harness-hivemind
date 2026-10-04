import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { installVoiceOutcome } from '../src/voice-outcome.ts'

const callId = '11111111-1111-4111-8111-111111111111'
function fixture(interrupted = false) {
  const events = [{ type: 'hivemind/voice-call-ended', data: { callId, provider: 'codex', initialCheckIn: true,
    interrupted, hadUserSpeech: true, transcript: 'user: We sell software; sales are unknown.\nassistant: Understood.' } }] as unknown as SessionEvent[]
  const append = vi.fn((type: string, data: unknown) => events.push({ type, data } as unknown as SessionEvent))
  const agent = { session: { header: { agentPreset: 'hivemind-hq' }, snapshotEvents: () => events, append } } as unknown as Agent
  let tool: ToolDefinition | undefined
  const flush = vi.fn(async () => true)
  installVoiceOutcome({ effect: (run: () => void) => run(),
    tools: { register: (value: ToolDefinition) => { tool = value; return () => {} } },
    sessions: { flush } } as unknown as Context)
  return { agent, append, flush, execute: (args: unknown) => tool!.execute(args as never, { agent } as never) }
}
describe('native initial voice outcome', () => {
  it('saves explicit assessment once and requires the exact same-room call', async () => {
    const f = fixture()
    const args = { call_id: callId, status: 'complete', summary: 'Baseline established; sales explicitly unknown.', remaining: [] }
    await expect(f.execute(args)).resolves.toMatchObject({ saved: true, status: 'complete' })
    await expect(f.execute(args)).resolves.toMatchObject({ saved: true })
    expect(f.append).toHaveBeenCalledTimes(1)
    await expect(f.execute({ ...args, call_id: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow('baseline_call_receipt_required')
  })
  it('keeps interrupted calls pending and rejects malformed assessments', async () => {
    const f = fixture(true)
    const args = { call_id: callId, status: 'complete', summary: 'A call ended.', remaining: [] }
    await expect(f.execute(args)).rejects.toThrow('interrupted_baseline_remains_pending')
    await expect(f.execute({ ...args, status: 'incomplete', remaining: [''] })).rejects.toThrow('invalid_baseline_assessment')
    await expect(f.execute({ ...args, status: 'invalid' })).rejects.toThrow()
    await expect(f.execute({ ...args, status: 'incomplete', remaining: ['Current sales still unknown.'] })).resolves.toMatchObject({ status: 'incomplete' })
  })
})
