import { describe, expect, it } from 'vitest'
import { readDreamSynthesis } from '../src/client/dream-synthesis.ts'
const id = '11111111-1111-4111-a111-111111111111'
const value = { status: 'ready_to_complete', presentation: 'dream-synthesis-v1', runId: id,
  summary: 'I explored fundraising conversations.', next: '', discoveries: [{ memoryId: id, title: 'Investor questions can improve documents', content: 'A possible connection.', sourceIds: [id], saved: true }] }
const blocks = (data: unknown) => [{ type: 'text', text: JSON.stringify(data) }]
describe('Dreamer final presentation', () => {
  it('accepts durable receipt-backed discoveries and an empty successful exploration', () => {
    expect(readDreamSynthesis(blocks(value))?.discoveries).toHaveLength(1)
    expect(readDreamSynthesis(blocks({ ...value, discoveries: [] }))?.discoveries).toEqual([])
  })
  it('does not label an incomplete or invalid result as saved', () => {
    expect(readDreamSynthesis(blocks({ ...value, status: 'failed' }))).toBeUndefined()
    expect(readDreamSynthesis(blocks({ ...value, discoveries: [{ ...value.discoveries[0], saved: false }] }))).toBeUndefined()
    expect(readDreamSynthesis(blocks({ ...value, runId: 'bad' }))).toBeUndefined()
    expect(readDreamSynthesis([{ type: 'text', text: '{' }])).toBeUndefined()
    expect(readDreamSynthesis([null, {}, { type: 'image' }])).toBeUndefined()
  })
})
