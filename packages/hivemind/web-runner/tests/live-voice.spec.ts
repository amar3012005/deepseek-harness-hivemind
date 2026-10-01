import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { codexAccountId, voiceContextChunks, voiceSession, VOICE_INSTRUCTIONS, VOICE_TASK_INSTRUCTIONS } from '../src/live-voice.ts'

describe('HIVEMIND live voice configuration', () => {
  it('uses native client delegation and keeps authenticated context separate from instructions', () => {
    expect(voiceSession('gpt-live-1-codex', 'marin', 'company persona', 'caller profile')).toEqual({
      model: 'gpt-live-1-codex', instructions: 'company persona', audio: { output: { voice: 'marin' } },
      delegation: { type: 'client' }, initial_items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'caller profile' }] }],
    })
    expect(VOICE_INSTRUCTIONS).toContain('confirmed backend receipt')
    expect(VOICE_INSTRUCTIONS).toContain('HyperAgent memory is private operating experience')
    expect(VOICE_TASK_INSTRUCTIONS).toContain('{"operation":"recall","recall":{"query":"the user question","limit":1}}')
    expect(VOICE_TASK_INSTRUCTIONS).toContain('Keep existing authorization and approval rules')
  })
  it('bounds multibyte protocol appends without losing text', () => {
    const text = '🌙中文'.repeat(300)
    const chunks = voiceContextChunks(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every(chunk => Buffer.byteLength(chunk) <= 500)).toBe(true)
  })
  it('resolves account routing without returning the token', () => {
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } })).toString('base64url')
    expect(codexAccountId(`header.${payload}.signature`)).toBe('account-1')
    expect(() => codexAccountId('bad')).toThrow()
  })
  it('mounts voice by default without changing search provider selection', () => {
    const config = Config({ parentOrigins: [], ticketSecretEnv: 'TICKET', redisUrlEnv: 'REDIS', redisJtiPrefix: 'test:', sessionMaxAgeSeconds: 3600,
      serviceApiBase: 'https://core.example', serviceSecretEnv: 'SERVICE' } as unknown as Parameters<typeof Config>[0])
    expect(config.liveVoice).toMatchObject({ enabled: true, model: 'gpt-live-1-codex' })
  })
})
