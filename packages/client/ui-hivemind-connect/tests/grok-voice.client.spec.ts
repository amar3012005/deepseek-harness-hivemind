import { afterEach, describe, expect, it, vi } from 'vitest'
import { startGrokVoice } from '../src/client/grok-voice.ts'

class Socket {
  static OPEN = 1
  static instance: Socket
  readyState = 1
  binaryType = ''
  onopen?: () => void
  onmessage?: (event: { data: unknown }) => void
  onclose?: (event: { code: number }) => void
  onerror?: () => void
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3 })
  constructor(readonly url: string, readonly protocols: string[]) { Socket.instance = this }
}
class Audio {
  static processor: {
    onaudioprocess?: (event: { inputBuffer: { getChannelData: () => Float32Array } }) => void
    connect: () => void
    disconnect: () => void
  }
  createBuffer = () => ({ getChannelData: () => new Float32Array(2) })
  createBufferSource = () => ({ buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() })
  currentTime = 0
  destination = {}
  createMediaStreamDestination = () => ({ stream: {} })
  createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() })
  createScriptProcessor = () => { Audio.processor = { connect: vi.fn(), disconnect: vi.fn() }; return Audio.processor }
  close = async () => {}
  resume = async () => {}
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('native existing Grok PCM voice transport', () => {
  it('uses the returned signed capability and drops microphone frames during the closing window', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('AudioContext', Audio)
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ provider: 'grok', session_id: 'call-one',
      ws_url: 'wss://voice.example.test/voice', capability: 'test-capability', audio_format: { sample_rate: 16000 }, closing_after_ms: 165000 }) }))
    vi.stubGlobal('fetch', fetch)
    const track = { enabled: true }
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream
    const audio = { play: async () => {}, srcObject: null } as unknown as HTMLAudioElement
    const closing = vi.fn(); const answered = vi.fn()
    const connection = await startGrokVoice('session-own-room', stream, audio, vi.fn(), vi.fn(), vi.fn(), closing, answered)
    const socket = Socket.instance
    expect(socket.protocols).toEqual(['hm.tara.v1', 'hm.tara.cap.test-capability'])
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ sessionId: 'session-own-room' })
    socket.onopen?.()
    socket.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
    expect(answered).not.toHaveBeenCalled()
    socket.onmessage?.({ data: new Int16Array([100, 200]).buffer })
    expect(answered).toHaveBeenCalledOnce()
    const frame = { inputBuffer: { getChannelData: () => new Float32Array([0.5]) } }
    Audio.processor.onaudioprocess?.(frame)
    expect(socket.send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(165000)
    expect(track.enabled).toBe(false); expect(closing).toHaveBeenCalledOnce()
    Audio.processor.onaudioprocess?.(frame)
    expect(socket.send).toHaveBeenCalledTimes(1)
    connection.close()
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'runtime_end' }))
  })
})
