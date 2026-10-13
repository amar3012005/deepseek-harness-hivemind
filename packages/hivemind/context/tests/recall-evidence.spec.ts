import { describe, expect, it } from 'vitest'
import { structuredRecallExcerpt, recentConversationText } from '../src/index.ts'

describe('structured current recall evidence', () => {
  it('retains the exact latest offer when a long answer exceeds the history window', () => {
    const offer = 'Want me to research the remaining Wise customer gaps?'
    const projected = recentConversationText([{ turn: 10, user: 'Tell me about Wise customers', assistant: 'Evidence '.repeat(1000) + offer }], 3, 3000, true)
    expect(projected.length).toBeLessThanOrEqual(3000)
    expect(projected).toContain(offer)
    expect(projected).toContain('Tell me about Wise customers')
    expect(projected).toContain('contentExcerpt')
    expect(projected).not.toContain('hyperagents_history')
  })
  it('keeps every ranked record and citation, including a late ICP match, in valid JSON', () => {
    const results = Array.from({ length: 15 }, (_, i) => ({ id: `record-${i}`, title: i === 14 ? 'Wise ICP' : `Record ${i}`, citation_id: `citation-${i}`, content: 'Relevant evidence. '.repeat(200) }))
    const projected = structuredRecallExcerpt(JSON.stringify({ status: 'ready', result: { results, count: 15, source_receipt: { path: 'saved-receipt' } } }), 6000)
    expect(projected.length).toBeLessThanOrEqual(6000)
    const decoded = JSON.parse(projected)
    expect(decoded.result.results).toHaveLength(15)
    expect(decoded.result.results[14]).toMatchObject({ title: 'Wise ICP', citation_id: 'citation-14', content_truncated: true })
    expect(decoded.result.source_receipt).toEqual({ path: 'saved-receipt' })
  })
})
