// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeVoiceActivity, voiceLevel } from '../src/client/voice-activity.ts'

afterEach(() => vi.unstubAllGlobals())
describe('borrowed call audio visualization', () => {
  it('routes native provider speech to the speaker without microphone echo and preserves mute and cleanup', () => {
    const nodes: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
    const speaker = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
    const destination = {}
    const close = vi.fn(async () => {})
    class Context {
      destination = destination
      createGain = () => speaker
      createMediaStreamSource = () => { const node = { connect: vi.fn(), disconnect: vi.fn() }; nodes.push(node); return node }
      createAnalyser = () => ({ fftSize: 0, disconnect: vi.fn(), getByteTimeDomainData: vi.fn() })
      resume = async () => {}
      close = close
    }
    vi.stubGlobal('AudioContext', Context)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const stream = {} as MediaStream
    const output = observeVoiceActivity(stream, vi.fn(), true)
    expect(output.playsThroughWebAudio).toBe(true)
    expect(speaker.connect).toHaveBeenCalledWith(destination)
    expect(nodes[0]!.connect).not.toHaveBeenCalledWith(speaker)
    output.remote(stream)
    expect(nodes[1]!.connect).toHaveBeenCalledWith(speaker)
    output.setSpeakerMuted(true); expect(speaker.gain.value).toBe(0)
    output.remote(stream); expect(nodes[1]!.disconnect).toHaveBeenCalledOnce()
    expect(speaker.gain.value).toBe(0)
    output.setSpeakerMuted(false); expect(speaker.gain.value).toBe(1)
    output.stop(); output.stop()
    expect(speaker.disconnect).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
  it('stays quiet for silence and room noise, responds to speech', () => {
    expect(voiceLevel(new Uint8Array([128, 128]))).toBe(0)
    expect(voiceLevel(new Uint8Array([127, 129]))).toBe(0)
    expect(voiceLevel(new Uint8Array([64, 192]))).toBeGreaterThan(0)
  })
  it('reads user and provider audio independently and releases only its own nodes', () => {
    const sources: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
    const analysers: { fftSize: number; disconnect: ReturnType<typeof vi.fn>; getByteTimeDomainData: ReturnType<typeof vi.fn> }[] = []
    const close = vi.fn(async () => {})
    class Context {
      createMediaStreamSource = () => { const node = { connect: vi.fn(), disconnect: vi.fn() }; sources.push(node); return node }
      createAnalyser = () => {
        const node = { fftSize: 0, disconnect: vi.fn(), getByteTimeDomainData: vi.fn((data: Uint8Array) => data.fill(128)) }
        analysers.push(node); return node
      }
      resume = async () => {}
      close = close
    }
    let frame!: FrameRequestCallback
    vi.stubGlobal('AudioContext', Context)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1 }))
    const cancel = vi.fn(); vi.stubGlobal('cancelAnimationFrame', cancel)
    const track = { stop: vi.fn() }
    const stream = { getTracks: () => [track] } as unknown as MediaStream
    const levels = vi.fn()
    const meter = observeVoiceActivity(stream, levels)
    frame(40); expect(levels).toHaveBeenLastCalledWith({ user: 0, agent: 0 })
    meter.remote(stream)
    analysers[0]!.getByteTimeDomainData.mockImplementation((data: Uint8Array) => data.fill(192))
    frame(80)
    expect(levels.mock.calls.at(-1)![0]).toMatchObject({ agent: 0 })
    expect(levels.mock.calls.at(-1)![0].user).toBeGreaterThan(0)
    analysers[1]!.getByteTimeDomainData.mockImplementation((data: Uint8Array) => data.fill(192))
    frame(120); expect(levels.mock.calls.at(-1)![0].agent).toBeGreaterThan(0)
    meter.remote(stream); expect(sources[1]!.disconnect).toHaveBeenCalledOnce()
    meter.stop(); meter.stop()
    expect(close).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce()
    expect(track.stop).not.toHaveBeenCalled()
    expect(levels).toHaveBeenLastCalledWith({ user: 0, agent: 0 })
  })
})
