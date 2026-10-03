// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { WebsitePreview, WebsitePreviewUpdates } from '../src/client/WebsitePreview.tsx'
import { sourceUrl, successfulSources, websiteSources, websiteRead } from '../src/client/website-sources.ts'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
afterEach(cleanup)
const source = { url: 'https://example.com/', title: 'Example', seq: 3 }
it('uses the exact public source directly, with an always available external fallback', () => {
  const view = render(<WebsitePreview sources={[source]} selected={source} select={vi.fn()} t={key => key} />)
  expect(view.getByTitle('website.title').getAttribute('src')).toBe(source.url)
  expect(view.getByTitle('website.title').getAttribute('sandbox')).toBe('allow-scripts')
  expect(view.getByRole('link').getAttribute('href')).toBe(source.url)
  expect(view.getByRole('note').textContent).toBe('website.embedding')
  fireEvent.error(view.getByTitle('website.title'))
  expect(view.queryByTitle('website.title')).toBeNull()
  expect(view.getByRole('alert').textContent).toBe('website.failed')
  expect(view.getByRole('link').getAttribute('href')).toBe(source.url)
})
it('selects multiple real sources without guessing a URL', () => {
  const select = vi.fn()
  const second = { url: 'https://github.com/', title: 'GitHub', seq: 4 }
  const view = render(<WebsitePreview sources={[source, second]} selected={source} select={select} t={key => key} />)
  fireEvent.change(view.getByRole('combobox'), { target: { value: second.url } })
  expect(select).toHaveBeenCalledWith(second.url)
})
it('correlates successful results, deduplicates updates, and excludes failure/unsafe URLs', () => {
  const call = { type: 'tool/call', seq: 1, data: { callId: 'read', name: 'browser_markdown', arguments: JSON.stringify({ url: source.url }) } }
  const result = (seq: number) => ({ type: 'tool/result', seq, data: { message: { source: { callId: 'read' }, content: [{ content: [{ type: 'text', text: 'Read homepage' }] }] } } })
  const window = { entries: [call, result(2), result(3)].map(event => ({ type: 'event', event })) } as unknown as SessionEventWindow
  expect(websiteSources(window)).toEqual([{ ...source, title: 'example.com' }])
  expect(successfulSources({ name: 'browser_markdown', url: source.url, sources: [], seq: 1 }, '{"error":"failed"}', 2)).toEqual([])
  expect(sourceUrl('javascript:alert(1)')).toBeUndefined()
  expect(sourceUrl('http://localhost:3000')).toBeUndefined()
  expect(sourceUrl('https://user:password@example.com')).toBeUndefined()
})
it('opens only a newly received result, not restored history', () => {
  let window = { entries: [] } as unknown as SessionEventWindow
  const listeners = new Set<() => void>()
  const events = {
    getSnapshot: () => window,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const open = vi.fn()
  const view = render(<WebsitePreviewUpdates events={events} open={open} />)
  expect(open).not.toHaveBeenCalled()
  window = { entries: [
    { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'a', name: 'browser_links', arguments: JSON.stringify({ url: source.url }) } } },
    { type: 'event', event: { type: 'tool/result', seq: 3, data: { message: { source: { callId: 'a' }, content: [{ content: [{ type: 'text', text: '[]' }] }] } } } },
  ] } as unknown as SessionEventWindow
  view.rerender(<WebsitePreviewUpdates events={events} open={open} />)
  expect(open).toHaveBeenCalledExactlyOnceWith(source.url)
  view.rerender(<WebsitePreviewUpdates events={events} open={open} />)
  expect(open).toHaveBeenCalledTimes(1)
})
it('anchors a source card to successful result chronology', () => {
  const state = { name: 'parallel_search', sources: [], seq: 1 }
  const result = websiteRead.update!({ state } as never, { event: { type: 'tool/result', seq: 8, data: { message: { content: [{ content: [{ type: 'text', text: JSON.stringify({ results: [source] }) }] }] } } } } as never)
  const node = websiteRead.buildViewNode!({ state: result, start: { location: {} }, key: 'read', id: 'a' } as never)
  expect((node as { anchorSeq?: number } | null)?.anchorSeq).toBe(8)
})

it('does not auto-open restored sources when changing rooms', () => {
  const open = vi.fn()
  const empty = { entries: [] } as unknown as SessionEventWindow
  const first = { getSnapshot: () => empty, subscribe: () => () => {} }
  const restored = { entries: [
    { type: 'event', event: { type: 'hivemind/research-receipt', seq: 8, data: { sources: [source] } } },
  ] } as unknown as SessionEventWindow
  const second = { getSnapshot: () => restored, subscribe: () => () => {} }
  const view = render(<WebsitePreviewUpdates events={first} open={open} />)
  view.rerender(<WebsitePreviewUpdates events={second} open={open} />)
  expect(open).not.toHaveBeenCalled()
})
