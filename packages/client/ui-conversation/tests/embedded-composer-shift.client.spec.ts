import { describe, expect, it } from 'vitest'
import { embeddedComposerShift } from '../src/client/skeleton/ConversationRoot.js'

describe('embedded composer centering', () => {
  it('centers on the viewport while the chat seat has room', () => {
    expect(embeddedComposerShift(260, 1458, 984, 1728, false)).toBe(-125)
    expect(embeddedComposerShift(240, 1478, 984, 1728, false)).toBe(-115)
  })

  it('keeps the composer inside the seat on compact screens', () => {
    expect(embeddedComposerShift(260, 754, 744, 1024, false)).toBe(0)
    expect(embeddedComposerShift(240, 808, 744, 1024, false)).toBe(-16)
  })

  it('centers in the chat seat when Preview is open', () => {
    expect(embeddedComposerShift(240, 808, 744, 1728, true)).toBe(0)
  })
})
