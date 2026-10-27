/**
 * Paces visible Assistant text behind the network, the way consumer chat
 * clients do: model deltas arrive in uneven bursts, so the view keeps the
 * received text as a goal and reveals it at an adaptive rate. A steady base
 * rate covers a trickle; a backlog raises the rate in proportion, so the
 * reveal stays within about `STREAM_MAX_LAG_MS` of the received text: the
 * backlog decays with a time constant of a third of that bound.
 *
 * Frames come from `requestAnimationFrame` with a timer behind it, because a
 * background tab or a busy renderer can defer animation frames indefinitely
 * and the text would then appear only when the message completes. A hidden
 * tab, reduced motion, or a finished message shows the whole text at once.
 */
import { useEffect, useRef, useState } from 'react'

/** Length of one 60 Hz frame; the reveal clock never counts less per tick. */
export const STREAM_FRAME_MS = 1000 / 60
/** Characters revealed per frame while no backlog has built up. */
export const STREAM_BASE_CHARS_PER_FRAME = 3
/** Backlog drain target: the reveal speeds up until it is at most about this far behind. */
export const STREAM_MAX_LAG_MS = 300
/** Longest elapsed time one tick may account for, so a stalled tab resumes at a bounded step. */
const MAX_TICK_MS = 100
/** Timer that advances the reveal when no animation frame arrives. */
const FALLBACK_MS = 50

/**
 * Advance the fractional reveal position by one tick.
 * @param position - Characters already revealed, fractional between ticks.
 * @param goal - Characters received so far.
 * @param elapsedMs - Time since the previous tick; counted as at least one frame so the first characters never wait.
 * @returns The next position, never beyond `goal`. The rate is the larger of the base rate and the backlog divided by
 * a third of `STREAM_MAX_LAG_MS`.
 */
export function advanceReveal(position: number, goal: number, elapsedMs: number): number {
  if (position >= goal) return goal
  const elapsed = Math.min(MAX_TICK_MS, Math.max(STREAM_FRAME_MS, elapsedMs))
  const base = STREAM_BASE_CHARS_PER_FRAME / STREAM_FRAME_MS
  const rate = Math.max(base, (goal - position) / (STREAM_MAX_LAG_MS / 3))
  return Math.min(goal, position + rate * elapsed)
}

/**
 * Cut text at a revealed length without splitting a surrogate pair.
 * @param text - Full text of one block.
 * @param cut - Revealed UTF-16 length within this block.
 * @returns The visible prefix; a lone high surrogate at the cut is kept with its pair.
 */
export function revealedPrefix(text: string, cut: number): string {
  if (cut >= text.length) return text
  if (cut <= 0) return ''
  const last = text.charCodeAt(cut - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? cut + 1 : cut
  return text.slice(0, end)
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/**
 * Reveal streamed text at an adaptive pace.
 *
 * Reveal runs only while `streaming` is true. A finished message, or any
 * message rendered without a live stream, shows its full text at once. A
 * transition into streaming starts from the text already present, so mounting
 * or re-entering a view never replays earlier text. Reduced motion, or a
 * hidden tab, shows the full text at once; a tab that turns hidden mid-stream
 * flushes the backlog.
 * @param total - Length of the text received so far.
 * @param streaming - Whether the owning message is still streaming.
 * @returns The revealed length, between 0 and `total`.
 */
export function useStreamReveal(total: number, streaming: boolean): number {
  const active = streaming && !prefersReducedMotion()
  const [shown, setShown] = useState(total)
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    setShown(total)
  }
  const goal = useRef(total)
  const position = useRef(total)
  useEffect(() => { goal.current = total })
  const pending = active && shown < total
  useEffect(() => {
    if (!active) { position.current = goal.current; return undefined }
    if (!pending) { position.current = Math.max(position.current, shown); return undefined }
    let frame: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = now() - STREAM_FRAME_MS
    const stop = (): void => {
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
      if (timer !== undefined) clearTimeout(timer)
      frame = undefined
      timer = undefined
    }
    const tick = (): void => {
      stop()
      const time = now()
      position.current = tabHidden()
        ? goal.current
        : advanceReveal(position.current, goal.current, time - last)
      last = time
      setShown(Math.floor(position.current))
      if (position.current < goal.current) schedule()
    }
    const schedule = (): void => {
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(tick)
      timer = setTimeout(tick, FALLBACK_MS)
    }
    const flush = (): void => {
      if (!tabHidden()) return
      stop()
      position.current = goal.current
      setShown(goal.current)
    }
    document.addEventListener('visibilitychange', flush)
    tick()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', flush)
    }
  }, [active, pending])
  return active ? Math.min(shown, total) : total
}
