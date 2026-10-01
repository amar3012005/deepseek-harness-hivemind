/** Only the successful native dream_finish receipt owns this presentation. */
export interface DreamDiscovery {
  memoryId: string
  title: string
  content: string
  sourceIds: string[]
  saved: true
  meaning?: string | null
  uncertainty?: string | null
  sources?: Array<{ id: string; title: string; content: string }>
}
export interface DreamSynthesis { presentation: 'dream-synthesis-v1'; runId: string; summary: string; next: string; discoveries: DreamDiscovery[] }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function readDreamSynthesis(content: readonly unknown[]): DreamSynthesis | undefined {
  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'text' || !('text' in block) || typeof block.text !== 'string') continue
    try {
      const value = JSON.parse(block.text)
      if (value?.presentation !== 'dream-synthesis-v1' || value.status !== 'ready_to_complete'
        || typeof value.runId !== 'string' || !uuid.test(value.runId) || typeof value.summary !== 'string'
        || typeof value.next !== 'string' || !Array.isArray(value.discoveries)) continue
      if (!value.discoveries.every((item: DreamDiscovery) => item && item.saved === true
        && typeof item.memoryId === 'string' && uuid.test(item.memoryId) && typeof item.title === 'string'
        && typeof item.content === 'string' && Array.isArray(item.sourceIds)
        && item.sourceIds.every(id => typeof id === 'string' && uuid.test(id))
        && (item.meaning == null || typeof item.meaning === 'string')
        && (item.uncertainty == null || typeof item.uncertainty === 'string')
        && (item.sources === undefined || (Array.isArray(item.sources) && item.sources.every(source =>
          source && typeof source.id === 'string' && uuid.test(source.id) && typeof source.title === 'string' && typeof source.content === 'string'))) )) continue
      return value as DreamSynthesis
    } catch { /* Ordinary tool prose is not a Dreamer presentation. */ }
  }
  return undefined
}

/** Keep section labels readable when a model puts all three sections in one text field. */
export function discoverySections(discovery: DreamDiscovery): { finding: string; meaning?: string; uncertainty?: string } {
  const text = discovery.content.replace(/^Finding:\s*/i, '')
  const meaningAt = text.search(/What it means:\s*/i)
  const uncertaintyAt = text.search(/What remains uncertain:\s*/i)
  const findingEnd = Math.min(...[meaningAt, uncertaintyAt].filter(index => index >= 0), text.length)
  const meaning = discovery.meaning ?? (meaningAt < 0 ? undefined
    : text.slice(meaningAt, uncertaintyAt > meaningAt ? uncertaintyAt : undefined).replace(/^What it means:\s*/i, '').trim())
  const uncertainty = discovery.uncertainty ?? (uncertaintyAt < 0 ? undefined
    : text.slice(uncertaintyAt).replace(/^What remains uncertain:\s*/i, '').trim())
  return { finding: text.slice(0, findingEnd).trim(), ...(meaning ? { meaning } : {}), ...(uncertainty ? { uncertainty } : {}) }
}
