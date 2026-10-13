import { describe, expect, it } from 'vitest'
import type { RunningToolCall } from '../src/client/contract/snapshot.ts'
import { brainActivity } from '../src/client/chat/brain-activity.ts'

const call = (name: string, args: Record<string, unknown> = {}, time = 1): RunningToolCall => ({
  name, argsRaw: JSON.stringify(args), callId: name, time, turn: 1, step: 1, subCalls: [],
})

describe('native Brain activity cues', () => {
  it('has no invented tool activity when no call is running', () => {
    expect(brainActivity([])).toBeUndefined()
  })
  it('does not crash the chat when an invalid or partial tool argument is logged', () => {
    expect(() => brainActivity([{ ...call('hivemind_meta'), argsRaw: 'null' }])).not.toThrow()
    expect(() => brainActivity([call('hivemind_connected_task', { action: 'search', queries: [null] })])).not.toThrow()
  })
  it('labels memory and screenshots from their actual native call', () => {
    expect(brainActivity([call('hivemind_meta', { operation: 'recall' })])?.label).toBe('Searching company brain')
    expect(brainActivity([call('hivemind_browser_capture')])?.label).toBe('Capturing website screenshot')
  })
  it('uses Gmail identity but never displays private queries or message arguments', () => {
    const status = brainActivity([call('hivemind_connected_task', { action: 'execute', tool_slug: 'GMAIL_FETCH_EMAILS',
      arguments: { query: 'private sender and subject' } })])
    expect(status).toEqual({ app: 'gmail', label: 'Gmail: reading' })
    expect(JSON.stringify(status)).not.toContain('private')
  })
  it('reflects actual child tool dispatch while preserving native ordering', () => {
    const parent = { ...call('hivemind_connected_task', { action: 'schemas', tool_slug: 'GMAIL_FETCH_EMAILS' }),
      subCalls: [call('GMAIL_CREATE_EMAIL_DRAFT', {}, 2)] }
    expect(brainActivity([parent])).toEqual({ app: 'gmail', label: 'Gmail: writing' })
  })
})
