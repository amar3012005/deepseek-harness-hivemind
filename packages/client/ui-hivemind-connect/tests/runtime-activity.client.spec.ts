import { describe, expect, it } from 'vitest'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { currentActivity } from '../src/client/RuntimeActivity.tsx'
function window(...events: Array<{ type: string; data: unknown }>): SessionEventWindow {
  return { entries: events.map(event => ({ type: 'event', event })) } as unknown as SessionEventWindow
}
const start = { type: 'turn/start', data: { turn: 1 } }
const call = (name: string, id = 'a') => ({ type: 'tool/call', data: { name, callId: id } })
const result = (id = 'a') => ({ type: 'tool/result', data: { message: { source: { callId: id } } } })
describe('quiet Runtime activity', () => {
  it('shows a factual recognized running tool, never raw arguments', () => {
    expect(currentActivity(window(start, call('browser_markdown')), 1)).toBe('activity.website')
    expect(currentActivity(window(start, call('parallel_search')), 1)).toBe('activity.search')
    expect(currentActivity(window(start, call('hyperagents_memory')), 1)).toBe('activity.memory')
    expect(currentActivity(window(start, call('hivemind_generate')), 1)).toBe('activity.draft')
  })
  it('clears completed, unknown, other-turn and ended activity', () => {
    expect(currentActivity(window(start, call('browser_markdown'), result()), 1)).toBeUndefined()
    expect(currentActivity(window(start, call('unknown')), 1)).toBeUndefined()
    expect(currentActivity(window(start, call('browser_markdown')), 2)).toBeUndefined()
    expect(currentActivity(window(start, call('browser_markdown'), { type: 'turn/end', data: { turn: 1 } }), 1)).toBeUndefined()
  })
  it('keeps one current label while parallel tools complete independently', () => {
    expect(currentActivity(window(start, call('browser_markdown'), call('wait_agent', 'b')), 1)).toBe('activity.team')
    expect(currentActivity(window(start, call('browser_markdown'), call('wait_agent', 'b'), result('b')), 1)).toBe('activity.website')
  })
})
