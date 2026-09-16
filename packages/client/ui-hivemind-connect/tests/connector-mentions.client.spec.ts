// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ConnectorChips } from '../src/client/ConnectorChips.tsx'
import { createConnectorMentionSource } from '../src/client/ConnectorMentions.ts'

describe('HIVE-MIND connector mentions', () => {
  it('does not render suggestions when the native shell has no blank session yet', () => {
    expect(ConnectorChips({ visible: false, insertMention: () => {} })).toBeNull()
  })

  it('does not load a catalog until the user types an @ query', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ connectors: [{
      slug: 'gmail', name: 'Gmail', connected: true, logo: 'https://logos.composio.dev/api/gmail',
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
    expect(candidates).toMatchObject([{ name: 'Gmail', description: 'Connected app', value: 'gmail', logoUrl: 'https://logos.composio.dev/api/gmail' }])
    expect(source.onPick({ candidate: candidates[0]! })).toEqual({
      insert: {
        source: 'connectors',
        ref: 'gmail',
        label: 'Gmail',
        clipboardText: '@Gmail',
        logoUrl: 'https://logos.composio.dev/api/gmail',
      },
    })
  })
})
