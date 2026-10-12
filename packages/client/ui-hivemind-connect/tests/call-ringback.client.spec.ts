import { afterEach, expect, it, vi } from 'vitest'
import { startCallRingback } from '../src/client/call-ringback.ts'
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('starts local ringback immediately and closes all audio once when stopped', () => {
  vi.useFakeTimers()
  const gain = {
    gain: { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(), disconnect: vi.fn(),
  }
  const tones = Array.from({ length: 2 }, () => ({
    frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(),
  }))
  const close = vi.fn(async () => {})
  let index = 0
  vi.stubGlobal('AudioContext', class { currentTime = 0; destination = {}; createGain = () => gain; createOscillator = () => tones[index++]; resume = async () => {}; close = close })
  const stop = startCallRingback()
  expect(tones.every(tone => tone.start.mock.calls.length === 1)).toBe(true)
  expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalled()
  stop(); stop()
  vi.advanceTimersByTime(70000)
  expect(close).toHaveBeenCalledOnce()
  expect(tones.every(tone => tone.stop.mock.calls.length === 1)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
it('does not block calling when browser audio is unavailable', () => {
  vi.stubGlobal('AudioContext', undefined)
  expect(() => startCallRingback()()).not.toThrow()
})
