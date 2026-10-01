/** Live voice media is owned by this composer button and released on navigation. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './HiveLiveVoiceButton.module.css'

type Props = Pick<PropsRuntime<'conversation.input.right'>, 'sessionId' | 'useInput'> & PropsLocale<'workspace'>
interface VoiceConnection { peer: RTCPeerConnection; stream: MediaStream; audio: HTMLAudioElement; id?: string }

/** Start a company-context voice conversation without changing the text composer. */
export function HiveLiveVoiceButton({ sessionId, useInput, t }: Props) {
  const draft = useInput(value => value?.draft ?? '')
  const [state, setState] = useState<'idle' | 'connecting' | 'live'>('idle')
  const [error, setError] = useState(false)
  const [caption, setCaption] = useState('')
  const connection = useRef<VoiceConnection>()
  const generation = useRef(0)
  const stop = useCallback(() => {
    generation.current++
    const current = connection.current; connection.current = undefined
    current?.stream.getTracks().forEach(track => track.stop())
    current?.peer.close()
    if (current) { current.audio.pause(); current.audio.srcObject = null }
    if (current?.id) void fetch('/api/hivemind/voice/stop', { method: 'POST', credentials: 'include', keepalive: true,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: current.id }) }).catch(() => {})
    setState('idle'); setCaption('')
  }, [])
  useEffect(() => () => { stop() }, [sessionId, stop])
  const toggle = async () => {
    if (state !== 'idle') { stop(); return }
    const ticket = ++generation.current
    setState('connecting'); setError(false)
    let local: VoiceConnection | undefined
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      if (generation.current !== ticket) { stream.getTracks().forEach(track => track.stop()); return }
      const peer = new RTCPeerConnection()
      const audio = new Audio(); audio.autoplay = true
      local = { peer, stream, audio }; connection.current = local
      stream.getTracks().forEach(track => peer.addTrack(track, stream))
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
        void audio.play().catch(() => { setError(true) })
      }
      peer.onconnectionstatechange = () => {
        if (generation.current !== ticket) return
        if (peer.connectionState === 'connected') setState('live')
        if (['failed', 'closed'].includes(peer.connectionState)) { stop(); setError(true) }
      }
      const events = peer.createDataChannel('oai-events')
      events.onmessage = (event) => {
        if (generation.current !== ticket) return
        try {
          const value = JSON.parse(event.data)
          if (value.type === 'turn.done' && typeof value.turn?.transcript === 'string') setCaption(value.turn.transcript)
          if (value.type === 'error') { stop(); setError(true) }
        } catch { /* Ignore non-JSON provider transport frames. */ }
      }
      await peer.setLocalDescription(await peer.createOffer())
      const response = await fetch('/api/hivemind/voice/start', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, sdp: peer.localDescription?.sdp }), signal: AbortSignal.timeout(35000) })
      const value = await response.json() as { id?: string; sdp?: string }
      if (!response.ok || !value.id || !value.sdp) throw new Error('voice_unavailable')
      local.id = value.id
      if (generation.current !== ticket) {
        void fetch('/api/hivemind/voice/stop', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: value.id }) })
        return
      }
      await peer.setRemoteDescription({ type: 'answer', sdp: value.sdp })
    } catch {
      if (generation.current === ticket) { stop(); setError(true) }
      else { local?.stream.getTracks().forEach(track => track.stop()); local?.peer.close() }
    }
  }
  // A typed draft retains the ordinary upward send arrow; ongoing voice keeps its end control.
  if (draft.trim() && state === 'idle') return null
  const label = error ? t('voice.retry') : state === 'connecting' ? t('voice.connecting') : state === 'live' ? t('voice.end') : t('voice.start')
  return <div className={css.control} data-hivemind-live-voice>
    <Tooltip label={label} side="top" delayMs={300}>
      <button type="button" className={css.button} aria-label={label} aria-pressed={state === 'live'} onClick={() => { void toggle() }}>
        {state === 'live' ? <span className={css.stop} /> : <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden><path d="M3 8v4m3-7v10m4-13v16m4-13v10m3-7v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>}
      </button>
    </Tooltip>
    {state !== 'idle' && <span className={css.caption} role="status">{caption || t(state === 'connecting' ? 'voice.connecting' : 'voice.listening')}</span>}
  </div>
}
