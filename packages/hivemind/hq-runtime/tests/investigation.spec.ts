import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { investigationExpired } from '../src/investigation.ts'

function events(values: unknown[]): SessionEvent[] { return values as SessionEvent[] }

describe('public investigation lifetime', () => {
  const scoped = events([
    { type: 'hivemind/hq-public-investigation', seq: 1, data: { enabled: true } },
    { type: 'turn/start', seq: 2, data: { turn: 1 } },
  ])
  it('keeps the requested investigation restricted for its complete turn', () => {
    expect(investigationExpired(scoped, 1)).toBe(false)
  })
  it('expires old test isolation before later employee coordination', () => {
    expect(investigationExpired(scoped, 2)).toBe(true)
    expect(investigationExpired(scoped, 6)).toBe(true)
  })
  it('does not expire a new explicit scope or an already disabled scope', () => {
    expect(investigationExpired([], 2)).toBe(false)
    expect(investigationExpired(events([...scoped,
      { type: 'hivemind/hq-public-investigation', seq: 3, data: { enabled: false } },
    ]), 2)).toBe(false)
    expect(investigationExpired(events([...scoped,
      { type: 'hivemind/hq-public-investigation', seq: 3, data: { enabled: true } },
      { type: 'turn/start', seq: 4, data: { turn: 2 } },
    ]), 2)).toBe(false)
  })
})
