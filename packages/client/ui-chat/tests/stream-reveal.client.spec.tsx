// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advanceReveal, revealedPrefix, useStreamReveal } from '../src/client/chat/stream-reveal.ts'

function Probe({ total, streaming }: { total: number; streaming: boolean }) {
  return <span data-testid="revealed">{useStreamReveal(total, streaming)}</span>
}

let frames: FrameRequestCallback[] = []

/** Run every queued animation frame once, as the browser does per paint. */
function runFrame(): void {
  const batch = frames
  frames = []
  act(() => { for (const callback of batch) callback(0) })
}

function revealed(): number {
  return Number(screen.getByTestId('revealed').textContent)
}

function stubMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

beforeEach(() => {
  frames = []
  stubMotion(false)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('advanceReveal', () => {
  it('reveals the first token at once and otherwise closes a quarter of the backlog', () => {
    expect(advanceReveal(0, 37)).toBe(37)
    expect(advanceReveal(100, 180)).toBe(120)
    expect(advanceReveal(120, 120)).toBe(120)
  })

  it('keeps a small backlog advancing and bounds a burst to the maximum step', () => {
    expect(advanceReveal(10, 11)).toBe(11)
    expect(advanceReveal(100, 1100)).toBe(300)
    expect(advanceReveal(50, 40)).toBe(40)
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
    expect(frames).toHaveLength(0)
  })

  it('shows the first streamed token on the next frame', () => {
    const view = render(<Probe total={0} streaming />)
    expect(revealed()).toBe(0)
    view.rerender(<Probe total={37} streaming />)
    runFrame()
    expect(revealed()).toBe(37)
  })

  it('does not replay text already present when a stream mounts or resumes', () => {
    const view = render(<Probe total={100} streaming />)
    expect(revealed()).toBe(100)
    view.rerender(<Probe total={180} streaming />)
    runFrame()
    expect(revealed()).toBe(120)
  })

  it('catches up toward the received length one frame at a time', () => {
    const view = render(<Probe total={0} streaming />)
    view.rerender(<Probe total={400} streaming />)
    runFrame()
    expect(revealed()).toBe(400)
    view.rerender(<Probe total={1000} streaming />)
    runFrame()
    expect(revealed()).toBe(550)
    runFrame()
    expect(revealed()).toBe(663)
  })

  it('completes the full text as soon as streaming ends', () => {
    const view = render(<Probe total={0} streaming />)
    view.rerender(<Probe total={1000} streaming />)
    expect(revealed()).toBe(0)
    view.rerender(<Probe total={1000} streaming={false} />)
    expect(revealed()).toBe(1000)
    runFrame()
    expect(frames).toHaveLength(0)
    expect(revealed()).toBe(1000)
  })

  it('shows the full text at once under reduced motion', () => {
    stubMotion(true)
    const view = render(<Probe total={0} streaming />)
    view.rerender(<Probe total={640} streaming />)
    expect(revealed()).toBe(640)
    expect(frames).toHaveLength(0)
  })
})
