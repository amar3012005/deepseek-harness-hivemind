import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAISearchProvider } from '../src/provider.ts'

afterEach(() => vi.unstubAllGlobals())

function provider() {
  return new OpenAISearchProvider({
    available: () => true, resolveToken: async () => ({ token: 'test-token', accountId: 'test-account' }),
    transport: 'codex', model: 'gpt-6-luna', timeoutMs: 1000, recordRequest: () => {},
  })
}

const search = { id: 'search-1', type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://example.com/source' }] } }
const message = { id: 'message-1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'A supported finding.', annotations: [{ type: 'url_citation', url: 'https://example.com/source', title: 'Source', start_index: 0, end_index: 1 }] }] }

function mockStream(events: unknown[]) {
  const fetchMock = vi.fn(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('Codex subscription search', () => {
  it('retains completed streamed items when terminal output is empty', async () => {
    const fetchMock = mockStream([
      { type: 'response.output_item.done', output_index: 0, item: search },
      { type: 'response.output_item.done', output_index: 1, item: message },
      { type: 'response.completed', response: { output: [] } },
    ])
    await expect(provider().search({ query: 'find sources', maxResults: 5 })).resolves.toEqual({ content: 'A supported finding.', sources: [{ url: 'https://example.com/source', title: 'Source' }], truncated: false })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(init.redirect).toBe('error')
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'gpt-6-luna', store: false, stream: true, tool_choice: 'required', tools: [{ type: 'web_search', search_context_size: 'low' }] })
  })

  it('deduplicates streamed items also present in terminal output', async () => {
    mockStream([{ type: 'response.output_item.done', output_index: 1, item: message }, { type: 'response.completed', response: { output: [search, message] } }])
    const result = await provider().search({ query: 'find sources' })
    expect(result.content).toBe('A supported finding.')
    expect(result.sources).toHaveLength(1)
  })

  it('rejects partial output without terminal completion', async () => {
    mockStream([{ type: 'response.output_item.done', output_index: 0, item: search }, { type: 'response.output_item.done', output_index: 1, item: message }])
    await expect(provider().search({ query: 'find sources' })).rejects.toMatchObject({ code: 'WEB_SEARCH_INCOMPLETE' })
  })

  it('rejects failed runs even when completed items arrived earlier', async () => {
    mockStream([{ type: 'response.output_item.done', output_index: 0, item: search }, { type: 'response.failed' }])
    await expect(provider().search({ query: 'find sources' })).rejects.toMatchObject({ code: 'WEB_SEARCH_INCOMPLETE' })
  })

  it('rejects answers without a confirmed web search', async () => {
    mockStream([{ type: 'response.completed', response: { output: [message] } }])
    await expect(provider().search({ query: 'find sources' })).rejects.toMatchObject({ code: 'WEB_SEARCH_EMPTY' })
  })

  it('does not issue a request after user cancellation', async () => {
    const fetchMock = mockStream([])
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))
    await expect(provider().search({ query: 'find sources' }, controller.signal)).rejects.toThrow('user cancelled')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
