import { describe, expect, it, vi } from 'vitest'
import { createConnectorMentionSource } from '../src/client/ConnectorMentions.ts'

describe('HIVE-MIND connector mentions', () => {
  it('does not load a catalog until the user types an @ query', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ connectors: [{
      slug: 'gmail', name: 'Gmail', connected: true,
    }] })))
    vi.stubGlobal('fetch', fetchMock)
    const source = createConnectorMentionSource()
    await expect(source.candidates({ sessionId: 'session-1' as never }, {
      query: '', signal: new AbortController().signal,
    })).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()

    const candidates = await source.candidates({ sessionId: 'session-1' as never }, {
      query: 'gma', signal: new AbortController().signal,
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/hivemind/connectors?q=gma', expect.objectContaining({ credentials: 'include' }))
    expect(candidates).toMatchObject([{ name: 'Gmail', description: 'Connected app', value: 'Gmail' }])
    expect(source.onPick({ candidate: candidates[0]! })).toEqual({ text: '@Gmail ' })
  })
})
