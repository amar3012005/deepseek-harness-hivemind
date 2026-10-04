import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { RUNTIME_VOICE_INSTRUCTIONS, RUNTIME_AWAKENING_CALL_AGENDA, needsAwakeningCallAgenda, runtimeVoiceEvidence, runtimeVoiceOpening } from '../src/runtime-voice.ts'

const voice = (text: string): SessionEvent => ({ type: 'user/message', data: createUserMessage({
  content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'hivemind-live-voice', form: 'recall' },
}) }) as SessionEvent

describe('Runtime operator voice context', () => {
  it('opens Runtime once after session start with the initial agenda', () => {
    const opening = runtimeVoiceOpening(true, true, 'opening')
    expect(opening('turn.done')).toBeUndefined()
    expect(opening('session.started')).toMatchObject({ type: 'session.context.append',
      event_id: 'opening', channel: 'speakable', content: [{ type: 'input_text', text: expect.stringContaining('first-check-in opening') }] })
    expect(opening('session.started')).toBeUndefined()
  })
  it('continues later agendas and leaves ordinary HIVEMIND calls unchanged', () => {
    expect(runtimeVoiceOpening(true, false, 'later')('session.started')?.content[0]?.text).toContain('do not restart onboarding')
    expect(runtimeVoiceOpening(false, true, 'ordinary')('session.started')).toBeUndefined()
    expect(RUNTIME_VOICE_INSTRUCTIONS).toContain('Lead the conversation')
    expect(RUNTIME_VOICE_INSTRUCTIONS).toContain('Allow thinking pauses and interruptions')
  })
  it('keeps Runtime identity and the supplied first-check-in agenda distinct', () => {
    expect(RUNTIME_VOICE_INSTRUCTIONS).toContain("our company's AI Chief of Staff")
    expect(RUNTIME_VOICE_INSTRUCTIONS).toContain('same Runtime backend')
    expect(RUNTIME_AWAKENING_CALL_AGENDA).toContain('3-minute operator conversation')
    expect(RUNTIME_AWAKENING_CALL_AGENDA).toContain('BY THEIR FIRST NAME')
    expect(RUNTIME_AWAKENING_CALL_AGENDA).toContain('ONE short focused follow-up')
    expect(RUNTIME_AWAKENING_CALL_AGENDA).toContain('Never make commitments, launch work')
  })
  it('does not count a generic call or an unanswered start as the new baseline discussion', () => {
    expect(needsAwakeningCallAgenda([])).toBe(true)
    expect(needsAwakeningCallAgenda([voice('Completed live voice conversation:\nuser: Hello')])).toBe(true)
    expect(needsAwakeningCallAgenda([voice(`Live voice system instructions:\n${RUNTIME_AWAKENING_CALL_AGENDA}`)])).toBe(true)
  })
  it('continues normally after an actual initial spoken check-in; reset clears room history', () => {
    const events = [voice(`Live voice system instructions:\n${RUNTIME_AWAKENING_CALL_AGENDA}`),
      voice('Completed live voice conversation:\nuser: Our objective is internal customer research.')]
    expect(needsAwakeningCallAgenda(events)).toBe(false)
    expect(needsAwakeningCallAgenda([])).toBe(true)
  })
  it('includes latest task, handoff and schedule evidence without inventing business metrics', () => {
    const events = [{ type: 'team/task', data: { task: { status: 'completed' } } },
      { type: 'hivemind/hq-rest-confirmed', data: { effectiveWakeAt: '2026-10-05T05:00:00Z' } }] as unknown as SessionEvent[]
    const result = runtimeVoiceEvidence(events)
    expect(result).toContain('completed')
    expect(result).toContain('2026-10-05T05:00:00Z')
    expect(result).toContain('Missing business metrics remain unknown')
  })
})
