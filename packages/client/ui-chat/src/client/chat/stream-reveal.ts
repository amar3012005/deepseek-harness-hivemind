/**
 * Paces visible Assistant text behind the network. Each animation frame reveals
 * a fraction of the unshown backlog, so the steady-state lag is about
 * `CATCH_UP_DIVISOR` frames (about 67 ms at 60 Hz) and a burst drains over a few
 * frames in bounded steps.
 */
import { useEffect, useRef, useState } from 'react'

/** Each frame reveals one of this many shares of the backlog. */
const CATCH_UP_DIVISOR = 4
/** Smallest reveal per frame, so a short backlog still advances. */
const MIN_STEP = 2
/** Largest reveal per frame, which keeps a burst at typing speed rather than a jump. */
const MAX_STEP = 200

/**
 * Advance the revealed UTF-16 length toward the received length by one frame.
 * @param shown - Length already on screen.
 * @param goal - Length of the text received so far.
 * @returns The next revealed length, never beyond `goal`. The first token
 * reveals at once: a zero reveal jumps to `goal`.
 */
export function advanceReveal(shown: number, goal: number): number {
  if (shown >= goal) return goal
  if (shown === 0) return goal
  const step = Math.min(MAX_STEP, Math.max(MIN_STEP, Math.ceil((goal - shown) / CATCH_UP_DIVISOR)))
  return Math.min(goal, shown + step)
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

/**
 * Reveal streamed text one animation frame at a time.
 *
 * Reveal runs only while `streaming` is true. A finished message, or any
 * message rendered without a live stream, shows its full text at once. A
 * transition into streaming starts from the text already present, so mounting
 * or re-entering a view never replays earlier text. Reduced motion, or a
 * platform without `requestAnimationFrame`, shows the full text at once.
 * @param total - Length of the text received so far.
 * @param streaming - Whether the owning message is still streaming.
 * @returns The revealed length, between 0 and `total`.
 */
export function useStreamReveal(total: number, streaming: boolean): number {
  const active = streaming && !prefersReducedMotion() && typeof requestAnimationFrame === 'function'
  const [shown, setShown] = useState(total)
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    setShown(total)
  }
  const goal = useRef(total)
  useEffect(() => { goal.current = total })
  const pending = active && shown < total
  useEffect(() => {
    if (!pending) return undefined
    const frame = requestAnimationFrame(() => {
      setShown(current => advanceReveal(current, goal.current))
    })
    return () => { cancelAnimationFrame(frame) }
  }, [pending, shown])
  return active ? Math.min(shown, total) : total
}
