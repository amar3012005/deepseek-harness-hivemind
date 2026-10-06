/**
 * Notifier: microtask/frame batching, rebuild-before-notify ordering,
 * no-listener laziness, synchronous notifyNow, and unsubscribe.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Notifier } from '../src/client/sessions/notifier.ts'

const microtask = (): Promise<void> => new Promise((resolve) => { queueMicrotask(resolve) })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Session notifier', () => {
  it('collapses N markDirty calls into one flush, rebuilding before notifying', async () => {
    const order: string[] = []
    const notifier = new Notifier(() => order.push('rebuild'))
    notifier.subscribe(() => order.push('notify'))
    notifier.markDirty()
    notifier.markDirty()
    notifier.markDirty()
    expect(order).toEqual([]) // nothing until the microtask boundary
    await microtask()
    expect(order).toEqual(['rebuild', 'notify'])
  })

  it('skips rebuild with zero listeners and ensureFresh rebuilds lazily exactly once', async () => {
    let rebuilds = 0
    const notifier = new Notifier(() => { rebuilds++ })
    notifier.markDirty()
    await microtask()
    expect(rebuilds).toBe(0) // lazy: kept dirty
    notifier.ensureFresh()
    expect(rebuilds).toBe(1)
    notifier.ensureFresh()
    expect(rebuilds).toBe(1) // clean: no second rebuild
  })

  it('notifyNow runs listeners synchronously (controlled-input contract)', () => {
    const order: string[] = []
    const notifier = new Notifier(() => order.push('rebuild'))
    notifier.subscribe(() => order.push('notify'))
    notifier.notifyNow()
    expect(order).toEqual(['rebuild', 'notify']) // before returning, no microtask needed
  })

  it('notifyNow with zero listeners stays lazy like markDirty', () => {
    let rebuilds = 0
    const notifier = new Notifier(() => { rebuilds++ })
    notifier.notifyNow()
    expect(rebuilds).toBe(0)
    notifier.ensureFresh()
    expect(rebuilds).toBe(1)
  })

  it('a scheduled flush after notifyNow already flushed is a no-op', async () => {
    let rebuilds = 0
    const notifier = new Notifier(() => { rebuilds++ })
    notifier.subscribe(() => undefined)
    notifier.markDirty() // schedules the microtask flush
    notifier.notifyNow() // flushes synchronously, clears dirty
    await microtask() // the scheduled flush finds dirty=false
    expect(rebuilds).toBe(1)
  })

  it('collapses frame-dirty changes into one cumulative frame publication', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const order: string[] = []
    const notifier = new Notifier(() => order.push('rebuild'))
    notifier.subscribe(() => order.push('notify'))

    notifier.markFrameDirty()
    notifier.markFrameDirty()
    notifier.markFrameDirty()

    expect(order).toEqual([])
    expect(frames).toHaveLength(1)
    frames.shift()!(0)
    expect(order).toEqual(['rebuild', 'notify'])
  })

  it('lets a structural microtask publication supersede a pending frame', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    let notifications = 0
    const notifier = new Notifier(() => undefined)
    notifier.subscribe(() => { notifications++ })

    notifier.markFrameDirty()
    notifier.markDirty()
    await microtask()
    expect(notifications).toBe(1)

    frames.shift()!(0)
    expect(notifications).toBe(1)
  })

  it('falls back to microtask batching when animation frames are unavailable', async () => {
    let notifications = 0
    const notifier = new Notifier(() => undefined)
    notifier.subscribe(() => { notifications++ })

    notifier.markFrameDirty()
    notifier.markFrameDirty()
    expect(notifications).toBe(0)
    await microtask()
    expect(notifications).toBe(1)
  })

  it('publishes received cumulative text within 100ms when a frame never arrives', () => {
    vi.useFakeTimers()
    const frames: FrameRequestCallback[] = []
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', cancel)
    let text = ''
    const published: string[] = []
    const notifier = new Notifier(() => published.push(text))
    const listener = vi.fn()
    notifier.subscribe(listener)
    text = 'received '
    notifier.markFrameDirty()
    text += 'deltas'
    notifier.markFrameDirty()
    vi.advanceTimersByTime(99)
    expect(published).toEqual([])
    vi.advanceTimersByTime(1)
    expect(published).toEqual(['received deltas'])
    expect(cancel).toHaveBeenCalledWith(1)
    frames[0]!(0) // late browser callback must not duplicate publication
    expect(listener).toHaveBeenCalledTimes(1)
    text += ' continue'
    notifier.markFrameDirty()
    vi.advanceTimersByTime(100)
    expect(published).toEqual(['received deltas', 'received deltas continue'])
  })

  it('cancels the fallback when a frame or synchronous flush wins', () => {
    vi.useFakeTimers()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const listener = vi.fn()
    const notifier = new Notifier(() => undefined)
    notifier.subscribe(listener)
    notifier.markFrameDirty()
    frames[0]!(0)
    expect(vi.getTimerCount()).toBe(0)
    notifier.markFrameDirty()
    notifier.notifyNow()
    expect(vi.getTimerCount()).toBe(0)
    frames[1]!(0)
    vi.advanceTimersByTime(100)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('unsubscribed listeners stop receiving notifications', async () => {
    let calls = 0
    const notifier = new Notifier(() => undefined)
    const unsubscribe = notifier.subscribe(() => { calls++ })
    notifier.notifyNow()
    expect(calls).toBe(1)
    unsubscribe()
    notifier.markDirty()
    await microtask()
    notifier.notifyNow()
    expect(calls).toBe(1)
  })
})
