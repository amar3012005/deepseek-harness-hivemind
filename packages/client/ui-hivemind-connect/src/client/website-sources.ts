/** Successful native read receipts, correlated by tool call identity. */
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
export interface WebsiteSource { url: string; title: string; seq: number; visited?: boolean; visitedSeq?: number }
export interface WebsiteRead { name: string; url?: string; sources: WebsiteSource[]; seq: number }
const browserReads = new Set(['browser_markdown', 'browser_extract', 'browser_links', 'browser_scrape', 'browser_capture'])
export function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|0\.|169\.254\.)/i.test(url.hostname)) return undefined
    return url.href
  } catch { return undefined }
}
export function successfulSources(read: WebsiteRead, text: string, seq: number): WebsiteSource[] {
  let result: unknown
  try { result = JSON.parse(text) } catch { result = text }
  const value = result !== null && typeof result === 'object' ? result as Record<string, unknown> : undefined
  if (value?.error || value?.success === false) return []
  if (browserReads.has(read.name)) {
    const url = sourceUrl(read.url)
    return url === undefined ? [] : [{ url, title: new URL(url).hostname, seq, visited: true }]
  }
  if (read.name !== 'parallel_search' || !Array.isArray(value?.results)) return []
  return value.results.flatMap((row: unknown) => {
    if (row === null || typeof row !== 'object') return []
    const item = row as Record<string, unknown>
    const url = sourceUrl(item.url)
    return url === undefined ? [] : [{ url, title: typeof item.title === 'string' && item.title.trim() ? item.title : new URL(url).hostname, seq }]
  })
}
export const websiteRead: ConversationNodeDefinition<WebsiteRead> = {
  kind: 'hivemind-website-source', target: 'chat',
  match: event => event.type === 'tool/call' && (browserReads.has(event.data.name) || event.data.name === 'parallel_search')
    ? { id: String(event.data.callId), role: 'start' }
    : event.type === 'tool/result' ? { id: String(event.data.message.source.callId), role: 'update' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'tool/call') throw new Error('Website source requires tool call')
    let args: { url?: string } = {}
    try { args = JSON.parse(match.event.data.arguments) as typeof args } catch { /* Invalid calls cannot supply a source. */ }
    return { name: match.event.data.name, ...(args.url === undefined ? {} : { url: args.url }), sources: [], seq: match.event.seq }
  },
  update: (context, match) => {
    if (context.state === undefined || match.event.type !== 'tool/result'
      || match.event.data.message.content.some(block => block.isError)) return context.state
    const text = match.event.data.message.content.flatMap(block => block.content).filter(block => block.type === 'text').map(block => block.text).join('')
    return { ...context.state, seq: match.event.seq, sources: successfulSources(context.state, text, match.event.seq) }
  },
  // Successful URLs drive the shared Preview observer. Their native tool
  // receipts remain in Work details; don't duplicate every source as a bubble.
  buildViewNode: () => null,
}
export function websiteSources(window: SessionEventWindow): WebsiteSource[] {
  const calls = new Map<string, WebsiteRead>()
  const sources = new Map<string, WebsiteSource>()
  const add = (urlValue: unknown, title: unknown, seq: number, visited = false) => {
    const url = sourceUrl(urlValue)
    const visitedSeq = visited ? seq : url === undefined ? undefined : sources.get(url)?.visitedSeq
    if (url !== undefined) sources.set(url, { url, title: typeof title === 'string' && title ? title : new URL(url).hostname, seq, visited: visited || sources.get(url)?.visited === true,
      ...(visitedSeq === undefined ? {} : { visitedSeq }) })
  }
  for (const entry of window.entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'tool/call') {
      let args: { url?: string } = {}
      try { args = JSON.parse(event.data.arguments) as typeof args } catch { /* No guessed target. */ }
      calls.set(String(event.data.callId), {
        name: event.data.name, ...(args.url === undefined ? {} : { url: args.url }), sources: [], seq: event.seq,
      })
    } else if (event.type === 'tool/result' && !event.data.message.content.some(block => block.isError)) {
      const read = calls.get(String(event.data.message.source.callId))
      if (read === undefined) continue
      const text = event.data.message.content.flatMap(block => block.content).filter(block => block.type === 'text').map(block => block.text).join('')
      for (const source of successfulSources(read, text, event.seq)) add(source.url, source.title, source.seq, source.visited)
    } else if (String(event.type) === 'hivemind/research-receipt') {
      const data = event.data as { sources?: { url?: unknown; title?: unknown }[] }
      for (const source of data.sources ?? []) add(source.url, source.title, event.seq)
    }
  }
  return [...sources.values()].sort((a, b) => a.seq - b.seq)
}
