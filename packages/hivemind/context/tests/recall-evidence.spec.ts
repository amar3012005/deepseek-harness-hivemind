import { describe, expect, it } from 'vitest'
import { structuredRecallExcerpt } from '../src/index.ts'

describe('structured current recall evidence', () => {
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
