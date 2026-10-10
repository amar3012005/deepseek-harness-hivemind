/** Native bounded presentation cuts and fixed durable cursor handling. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionHistoryController } from '../src/history.ts'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { historyWindowCut, readColdHistorySource } from '../src/cold-history.ts'

function fixtures(turns = 1000): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= turns; turn++) {
    const seq = events.length
    events.push({ type: 'user/message', seq: SessionSeq(seq), time: seq,
      data: createUserMessage({ content: [{ type: 'text', text: `Prompt ${turn}` }], source: { kind: 'user' } }),
      surfaceOp: 'append' })
    events.push({ type: 'turn/start', seq: SessionSeq(seq + 1), time: seq + 1, data: { turn } })
    events.push({ type: 'step/start', seq: SessionSeq(seq + 2), time: seq + 2, data: { turn, step: 1 } })
    events.push({ type: 'step/end', seq: SessionSeq(seq + 3), time: seq + 3, data: { turn, step: 1 } })
    events.push({ type: 'turn/end', seq: SessionSeq(seq + 4), time: seq + 4, data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

function setup(events = fixtures()) {
  const header: SessionHeader = { id: SessionId('history-window-test'), version: SESSION_FORMAT_VERSION,
    createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const read = vi.fn(async (offset: number, length: number) => ({ eventState: 'shared-frozen', events: events.slice(offset, offset + length) }))
  const closed = vi.fn()
  const handle = { header, inheritedEventCount: SessionLogOffset(0), read, [Symbol.asyncDispose]: closed }
  const persistence = {
    stat: vi.fn(async () => ({ header, eventCount: events.length })),
    open: vi.fn(async () => handle),
    openHistoryRead: vi.fn(async () => handle),
  }
  const cache = {
    coldReadFloor: vi.fn(() => SessionLogOffset(events.length - 1)),
    coldSnapshotSuffix: vi.fn((_header: SessionHeader, _inherited: SessionLogOffset, suffix: readonly SessionEvent[]) => ({
      asOfSeq: suffix.at(-1)?.seq ?? -1, values: {} })),
  }
  const attached = vi.fn(() => undefined)
  const ctx = { sessions: { get: attached }, get: (key: string) => key === 'sessionPersistence' ? persistence : cache } as unknown as Context
  return { ctx, header, read, cache, closed, attached, persistence }
}

describe('bounded native history', () => {
  it('bounds automatic turns without human prompts and preserves incomplete boundaries', async () => {
    const events = fixtures(1000).filter(event => event.type !== 'user/message')
      .map((event, seq) => ({ ...event, seq: SessionSeq(seq) }))
    const { ctx, header, read } = setup(events)
    const source = await readColdHistorySource(ctx, header.id, new AbortController().signal,
      { maxMessages: 50, maxTurns: 5, withProjections: true })
    expect(source?.source).toBe('window')
    expect(read.mock.calls.reduce((sum, [, length]) => sum + length, 0)).toBe(256)
    expect(historyWindowCut(events.slice(-21), 50, 5)).toBe(3980)
    expect(historyWindowCut(events.slice(-20), 50, 5)).toBeUndefined()
  })
  it.each([10, 1000])('opens five turns without checkpoints at %i turns', async (turns) => {
    const { ctx, header, cache, read } = setup(fixtures(turns))
    cache.coldReadFloor.mockReturnValue(SessionLogOffset(0))
    const source = await readColdHistorySource(ctx, header.id, new AbortController().signal,
      { maxMessages: 50, maxTurns: 5, withProjections: true })
    expect(source?.source).toBe('window')
    expect(source?.projections).toBeUndefined()
    expect(cache.coldSnapshotSuffix).not.toHaveBeenCalled()
    expect(read.mock.calls.reduce((sum, [, length]) => sum + length, 0)).toBeLessThanOrEqual(256)
  })
  it('presents an interrupted durable tail without inventing recovery events', async () => {
    const events = fixtures()
    events.splice(events.length - 2)
    const { ctx, header } = setup(events)
    const source = await readColdHistorySource(ctx, header.id, new AbortController().signal,
      { maxMessages: 50, maxTurns: 5, withProjections: true })
    expect(source?.cursor).toBe(events.length - 1)
    expect(source?.events.at(-1)).toEqual(events.at(-1))
    expect(source?.projections).toBeUndefined()
  })
  it('renders five turns while full restoration is blocked, then hydrates without a second snapshot', async () => {
    const fixture = setup()
    fixture.cache.coldReadFloor.mockReturnValue(SessionLogOffset(0))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('sessionPersistence', fixture.persistence as never)
    ctx.provide('sessionProjectionCache', fixture.cache as never)
    let release!: (value: SessionObservation) => void
    const observe = vi.fn(() => new Promise<SessionObservation>((resolve) => { release = resolve }))
    ctx.provide('sessionQuery', { observeSession: observe } as never)
    const complete: SessionObservation = {
      source: 'prepared', header: fixture.header, inheritedEventCount: SessionLogOffset(0),
      cursor: SessionSeq(4999), events: fixtures(), projections: { asOfSeq: SessionSeq(4999), values: {} },
      retain: () => complete, [Symbol.dispose]() {},
    }
    const promote = vi.fn()
    const history = new SessionHistoryController(ctx, promote)
    const abort = new AbortController()
    const iterator = history.follow({ address: { kind: 'session', sessionId: fixture.header.id }, maxTurns: 5 }, abort.signal)[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      expect(first.value).toMatchObject({ type: 'snapshot', cursor: 4999, hasMore: true })
      if (!first.done && first.value.type === 'snapshot') {
        expect(first.value.records).toHaveLength(25)
        expect(first.value.projectionsPending).toBe(true)
      }
      expect(observe).not.toHaveBeenCalled()
      const next = iterator.next()
      await vi.waitFor(() => { expect(observe).toHaveBeenCalledOnce() })
      expect(promote).not.toHaveBeenCalled()
      release(complete)
      expect((await next).value).toEqual({ type: 'projections', baseline: { asOfSeq: 4999, values: {} } })
      expect(promote).toHaveBeenCalledOnce()
    } finally {
      abort.abort()
      await iterator.return?.()
      await ctx.fiber.dispose()
    }
  })
  it('surfaces full-restoration failure after first-page delivery and does not promote', async () => {
    const fixture = setup()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('sessionPersistence', fixture.persistence as never)
    ctx.provide('sessionProjectionCache', fixture.cache as never)
    ctx.provide('sessionQuery', { observeSession: vi.fn(async () => { throw new Error('fixture restoration failure') }) } as never)
    const promote = vi.fn()
    const history = new SessionHistoryController(ctx, promote)
    const abort = new AbortController()
    const iterator = history.follow({ address: { kind: 'session', sessionId: fixture.header.id }, maxTurns: 5 }, abort.signal)[Symbol.asyncIterator]()
    try {
      expect((await iterator.next()).value).toMatchObject({ type: 'snapshot', projectionsPending: true })
      await expect(iterator.next()).rejects.toThrow('fixture restoration failure')
      expect(promote).not.toHaveBeenCalled()
    } finally {
      abort.abort()
      await iterator.return?.()
      await ctx.fiber.dispose()
    }
  })
  it('counts whole turns and includes the human prompt before turn start', () => {
    const events = fixtures(25)
    expect(historyWindowCut(events, 50, 20)).toBe(25)
    expect(historyWindowCut(events.slice(100), 50, 20)).toBeUndefined()
  })
  it('keeps source references for native message grouping', () => {
    const events = fixtures(2)
    const lastUser = events[5] as SessionEvent
    const referenced = { ...lastUser, sourceEventSeqs: [SessionSeq(2)] } as SessionEvent
    expect(historyWindowCut([...events.slice(0, 5), referenced, ...events.slice(6)], 1)).toBe(2)
  })
  it('reads a large cold tail and checkpoint suffix without a seq-zero read', async () => {
    const { ctx, header, read, closed } = setup()
    const source = await readColdHistorySource(ctx, header.id, new AbortController().signal,
      { maxMessages: 50, maxTurns: 20, withProjections: true })
    expect(source?.source).toBe('window')
    expect(source?.cursor).toBe(4999)
    expect(source?.events.filter(event => event.type === 'turn/start').length).toBeGreaterThanOrEqual(20)
    expect(read.mock.calls.every(([offset]) => offset > 0)).toBe(true)
    expect(read.mock.calls.reduce((sum, [, length]) => sum + length, 0)).toBeLessThan(300)
    expect(closed).toHaveBeenCalledOnce()
  })
  it('keeps an older page pinned while newer events already exist', async () => {
    const { ctx, header, read } = setup()
    const source = await readColdHistorySource(ctx, header.id, new AbortController().signal,
      { maxMessages: 10, beforeSeq: 4000, throughSeq: 4500, withProjections: false })
    expect(source?.cursor).toBe(4500)
    expect(source?.events.at(-1)?.seq).toBe(3999)
    expect(read.mock.calls.every(([offset, length]) => offset + length <= 4000)).toBe(true)
  })
  it('keeps interrupted-tail repair in the complete native observation', async () => {
    const events = fixtures()
    events.splice(events.length - 2)
    const { ctx, header, cache } = setup(events)
    const source = await readColdHistorySource(ctx, header.id, new AbortController().signal,
      { maxMessages: 50, maxTurns: 20, withProjections: true })
    expect(source).toBeUndefined()
    expect(cache.coldSnapshotSuffix).not.toHaveBeenCalled()
  })
  it('falls back to complete native observation for missing checkpoint units', async () => {
    const { ctx, header, cache, read } = setup()
    cache.coldReadFloor.mockReturnValue(SessionLogOffset(0))
    expect(await readColdHistorySource(ctx, header.id, new AbortController().signal,
      { maxMessages: 50, withProjections: true })).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })
  it('does not use a partial cut when checkpoint restore rejects or a session attaches', async () => {
    const first = setup()
    first.cache.coldSnapshotSuffix.mockImplementation(() => { throw new Error('checkpoint ahead') })
    expect(await readColdHistorySource(first.ctx, first.header.id, new AbortController().signal,
      { maxMessages: 50, withProjections: true })).toBeUndefined()
    const second = setup()
    second.attached.mockReturnValueOnce(undefined).mockReturnValueOnce({} as never)
    expect(await readColdHistorySource(second.ctx, second.header.id, new AbortController().signal,
      { maxMessages: 50, withProjections: false })).toBeUndefined()
  })
  it('retains ordinary observation for direct child lineage and future synthetic cursors', async () => {
    const { ctx, header, read } = setup()
    Object.assign(header, { origin: 'subagent' })
    expect(await readColdHistorySource(ctx, header.id, new AbortController().signal,
      { maxMessages: 50, withProjections: false })).toBeUndefined()
    Reflect.deleteProperty(header, 'origin')
    expect(await readColdHistorySource(ctx, header.id, new AbortController().signal,
      { maxMessages: 50, throughSeq: 5001, withProjections: false })).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })
  it('delivers the bounded snapshot before requesting complete Agent context', async () => {
    const fixture = setup()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('sessionPersistence', fixture.persistence as never)
    ctx.provide('sessionProjectionCache', fixture.cache as never)
    const completeEvents = fixtures()
    const dispose = vi.fn()
    const complete: SessionObservation = {
      source: 'prepared', header: fixture.header, inheritedEventCount: SessionLogOffset(0),
      cursor: SessionSeq(4999), events: completeEvents,
      retain: () => complete, [Symbol.dispose]: dispose,
    }
    const observe = vi.fn(async () => complete)
    ctx.provide('sessionQuery', { observeSession: observe } as never)
    const promote = vi.fn((source: SessionObservation) => { source[Symbol.dispose]() })
    const history = new SessionHistoryController(ctx, promote)
    const abort = new AbortController()
    const iterator = history.follow({ address: { kind: 'session', sessionId: fixture.header.id }, maxTurns: 20 }, abort.signal)[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      expect(first.value).toMatchObject({ type: 'snapshot', cursor: 4999, hasMore: true })
      if (first.done === false && first.value.type === 'snapshot') expect(first.value.records).toHaveLength(100)
      expect(observe).not.toHaveBeenCalled()
      const next = iterator.next()
      await vi.waitFor(() => { expect(promote).toHaveBeenCalledOnce() })
      expect(promote.mock.calls[0]?.[0].events).toHaveLength(5000)
      abort.abort()
      await next
    } finally {
      abort.abort()
      await iterator.return?.()
      await ctx.fiber.dispose()
    }
  })

})
