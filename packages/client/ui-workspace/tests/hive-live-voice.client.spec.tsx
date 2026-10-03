// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HiveLiveVoiceButton } from '../src/client/HiveLiveVoiceButton.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }))
const t = ((key: string) => key) as never
const input = (draft = '') => ((select: (value: { draft: string }) => unknown) => select({ draft })) as never
class Peer {
  static instance: Peer
  localDescription = { sdp: 'v=0\r\nfixture' }
  connectionState = 'new'
  close = vi.fn()
  addTrack = vi.fn()
  createDataChannel = vi.fn(() => ({}))
  createOffer = vi.fn(async () => ({}))
  setLocalDescription = vi.fn(async () => {})
  setRemoteDescription = vi.fn(async () => {})
  constructor() { Peer.instance = this }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('native HIVEMIND live voice composer', () => {
  it('acknowledges an invitation and starts the existing voice API even with a typed draft', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) } })
    vi.stubGlobal('RTCPeerConnection', Peer)
    vi.stubGlobal('Audio', class { autoplay = false; pause = vi.fn() })
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'room-1', sdp: 'answer' }) }))
    vi.stubGlobal('fetch', fetcher)
    render(<HiveLiveVoiceButton sessionId={'session-1' as never} useInput={input('draft')} t={t} />)
    const invitation = new CustomEvent('hivemind:start-room-call', { cancelable: true, detail: { sessionId: 'session-1' } })
    fireEvent(window, invitation)
    expect(invitation.defaultPrevented).toBe(true)
    await waitFor(() => { expect(Peer.instance.setRemoteDescription).toHaveBeenCalledOnce() })
    const repeat = new CustomEvent('hivemind:start-room-call', { cancelable: true, detail: { sessionId: 'session-1' } })
    fireEvent(window, repeat)
    expect(Peer.instance.close).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('leaves a typed draft to the ordinary send arrow', () => {
    render(<HiveLiveVoiceButton sessionId={'session-1' as never} useInput={input('hello')} t={t} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('releases microphone and remote room on navigation', async () => {
    const stop = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) } })
    vi.stubGlobal('RTCPeerConnection', Peer)
    vi.stubGlobal('Audio', class { autoplay = false; pause = vi.fn() })
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, json: async () => ({ id: 'room-1', sdp: 'answer' }) }))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<HiveLiveVoiceButton sessionId={'session-1' as never} useInput={input()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'voice.start' }))
    await waitFor(() => { expect(Peer.instance.setRemoteDescription).toHaveBeenCalled() })
    view.unmount()
    expect(stop).toHaveBeenCalledOnce()
    expect(Peer.instance.close).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/hivemind/voice/stop')
  })
  it('cancels a pending microphone request without opening a room', async () => {
    let release!: (stream: unknown) => void
    const stop = vi.fn(); const fetcher = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise((resolve) => { release = resolve }) } })
    vi.stubGlobal('fetch', fetcher)
    const view = render(<HiveLiveVoiceButton sessionId={'session-1' as never} useInput={input()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'voice.start' }))
    view.unmount(); release({ getTracks: () => [{ stop }] })
    await waitFor(() => { expect(stop).toHaveBeenCalledOnce() })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
