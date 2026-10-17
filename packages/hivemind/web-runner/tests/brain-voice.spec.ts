import { describe, expect, it } from 'vitest'
import { brainVoiceOpening, BRAIN_VOICE_INSTRUCTIONS } from '../src/brain-voice.ts'
describe('Brain native voice opening', () => {
  it('speaks once after session start without a Runtime baseline agenda', () => {
    const opening = brainVoiceOpening('brain-test')
    expect(opening('session.created')).toBeUndefined()
    const first = opening('session.started')
    expect(first?.type).toBe('session.context.append')
    expect(first?.content[0]?.text).toContain('company brain')
    expect(opening('session.started')).toBeUndefined()
    expect(BRAIN_VOICE_INSTRUCTIONS).toContain('You are not Runtime')
    expect(BRAIN_VOICE_INSTRUCTIONS).toContain('receipt')
  })
})
