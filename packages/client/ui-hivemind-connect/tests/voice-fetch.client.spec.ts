import { afterEach, describe, expect, it, vi } from 'vitest'
import { voiceFetch } from '../src/client/voice-fetch.ts'

afterEach(() => { vi.unstubAllGlobals() })
describe('voice authenticated carrier', () => {
  it('uses the shell carrier for primary and fallback control without fetching local app assets', async () => {
    const response = new Response('{}', { status: 200 })
    const native = vi.fn(async (_url: URL, _init: RequestInit) => response)
    const browser = vi.fn()
    vi.stubGlobal('__DSH_TRANSPORT__', { fetch: native, remoteHost: true })
    vi.stubGlobal('fetch', browser)
    const init = { method: 'POST', credentials: 'include' as const, body: '{}', signal: new AbortController().signal }
    for (const path of ['/api/hivemind/voice/start', '/api/hivemind/voice/stop', '/api/hivemind/voice/fallback/start', '/api/hivemind/voice/fallback/finish']) {
      expect(await voiceFetch(path, init)).toBe(response)
      expect(native.mock.calls.at(-1)?.[0].pathname).toBe(path)
      expect(native.mock.calls.at(-1)?.[1]).toBe(init)
    }
    expect(browser).not.toHaveBeenCalled()
  })
  it('preserves the served browser HTTP carrier', async () => {
    vi.stubGlobal('__DSH_TRANSPORT__', undefined)
    const browser = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', browser)
    await voiceFetch('/api/hivemind/voice/start', { method: 'POST' })
    expect(browser).toHaveBeenCalledWith('/api/hivemind/voice/start', { method: 'POST' })
  })
})
