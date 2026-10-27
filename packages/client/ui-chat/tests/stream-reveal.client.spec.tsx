// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STREAM_BASE_CHARS_PER_FRAME, STREAM_FRAME_MS, STREAM_MAX_LAG_MS,
  advanceReveal, revealedPrefix, useStreamReveal,
} from '../src/client/chat/stream-reveal.ts'

function Probe({ total, streaming }: { total: number; streaming: boolean }) {
  return <span data-testid="revealed">{useStreamReveal(total, streaming)}</span>
}

function revealed(): number {
  return Number(screen.getByTestId('revealed').textContent)
}

/** Run the fake clock for a number of 60 Hz frames. */
function frames(count: number): void {
  act(() => { vi.advanceTimersByTime(count * STREAM_FRAME_MS + 1) })
}

function stubMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  stubMotion(false)
})

afterEach(() => {
  cleanup()
  setHidden(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('advanceReveal', () => {
  it('reveals the base rate for a short backlog and never passes the goal', () => {
    expect(advanceReveal(0, 1000, STREAM_FRAME_MS)).toBeCloseTo(
      Math.max(STREAM_BASE_CHARS_PER_FRAME, 1000 * STREAM_FRAME_MS / (STREAM_MAX_LAG_MS / 3)), 5)
    expect(advanceReveal(10, 11, STREAM_FRAME_MS)).toBe(11)
    expect(advanceReveal(50, 40, STREAM_FRAME_MS)).toBe(40)
    expect(advanceReveal(40, 40, STREAM_FRAME_MS)).toBe(40)
  })

  it('moves faster as the backlog grows', () => {
    const small = advanceReveal(0, 12, STREAM_FRAME_MS)
    const large = advanceReveal(0, 3000, STREAM_FRAME_MS)
    expect(small).toBeCloseTo(STREAM_BASE_CHARS_PER_FRAME, 5)
    expect(large).toBeGreaterThan(small * 5)
  })

  it('drains a burst within twice the lag target', () => {
    let position = 0
    let elapsed = 0
    while (position < 1190 && elapsed < 5000) {
      position = advanceReveal(position, 1200, STREAM_FRAME_MS)
      elapsed += STREAM_FRAME_MS
    }
    expect(elapsed).toBeLessThan(STREAM_MAX_LAG_MS * 2)
  })

  it('bounds one tick after a stalled tab', () => {
    expect(advanceReveal(0, 100_000, 60_000)).toBe(advanceReveal(0, 100_000, 100))
  })
})

describe('revealedPrefix', () => {
  it('cuts at the revealed length and keeps a surrogate pair whole', () => {
    expect(revealedPrefix('hello', 2)).toBe('he')
    expect(revealedPrefix('hello', 0)).toBe('')
    expect(revealedPrefix('hello', 9)).toBe('hello')
    expect(revealedPrefix('a😀b', 2)).toBe('a😀')
  })
})

describe('useStreamReveal', () => {
  it('shows a finished message in full on mount and on later growth', () => {
    const view = render(<Probe total={500} streaming={false} />)
    expect(revealed()).toBe(500)
    view.rerender(<Probe total={900} streaming={false} />)
    expect(revealed()).toBe(900)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows the first streamed characters without waiting for a frame', () => {
    const view = render(<Probe total={0} streaming />)
    expect(revealed()).toBe(0)
    view.rerender(<Probe total={37} streaming />)
    expect(revealed()).toBeGreaterThanOrEqual(STREAM_BASE_CHARS_PER_FRAME)
    expect(revealed()).toBeLessThan(37)
  })

  it('does not replay text already present when a stream mounts or resumes', () => {
    const view = render(<Probe total={100} streaming />)
    expect(revealed()).toBe(100)
    view.rerender(<Probe total={180} streaming />)
    expect(revealed()).toBeGreaterThanOrEqual(100)
    expect(revealed()).toBeLessThan(130)
  })

  it('speeds up with the backlog and reaches the received text within the lag target', () => {
    const view = render(<Probe total={0} streaming />)
    view.rerender(<Probe total={1200} streaming />)
    const first = revealed()
    frames(1)
    const perFrameAtBacklog = revealed() - first
    expect(perFrameAtBacklog).toBeGreaterThan(STREAM_BASE_CHARS_PER_FRAME)
    frames(Math.ceil(STREAM_MAX_LAG_MS * 2 / STREAM_FRAME_MS))
    expect(revealed()).toBe(1200)
  })

  it('keeps a steady trickle at the base rate', () => {
    const view = render(<Probe total={0} streaming />)
    let received = 0
    for (let step = 0; step < 10; step++) {
      received += 12
      view.rerender(<Probe total={received} streaming />)
      frames(4)
    }
    expect(revealed()).toBe(received)
  })

  it('advances on the timer fallback when animation frames never arrive', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const view = render(<Probe total={0} streaming />)
    view.rerender(<Probe total={600} streaming />)
    const first = revealed()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(first).toBeLessThan(600)
    expect(revealed()).toBe(600)
  })

  it('completes the full text as soon as streaming ends', () => {
    const view = render(<Probe total={0} streaming />)
    view.rerender(<Probe total={1000} streaming />)
    expect(revealed()).toBeLessThan(1000)
    view.rerender(<Probe total={1000} streaming={false} />)
    expect(revealed()).toBe(1000)
    act(() => { vi.runOnlyPendingTimers() })
    expect(vi.getTimerCount()).toBe(0)
    expect(revealed()).toBe(1000)
  })

  it('flushes the backlog when the tab turns hidden', () => {
    const view = render(<Probe total={0} streaming />)
    view.rerender(<Probe total={5000} streaming />)
    expect(revealed()).toBeLessThan(5000)
    act(() => {
      setHidden(true)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(revealed()).toBe(5000)
  })

  it('shows the full text at once under reduced motion', () => {
    stubMotion(true)
    const view = render(<Probe total={0} streaming />)
    view.rerender(<Probe total={640} streaming />)
    expect(revealed()).toBe(640)
    expect(vi.getTimerCount()).toBe(0)
  })
})
