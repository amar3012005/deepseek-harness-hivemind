/** Live voice media is owned by this composer button and released on navigation. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CallColorWave } from './CallColorWave.tsx'
import { observeVoiceActivity, type VoiceLevels } from './voice-activity.ts'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { startGrokVoice } from './grok-voice.ts'
import { startCallRingback } from './call-ringback.ts'
import css from './HiveLiveVoiceButton.module.css'

type Props = Pick<PropsRuntime<'conversation.input.right'>, 'sessionId' | 'useInput'> & PropsLocale<'workspace'>
interface VoiceConnection { peer: Pick<RTCPeerConnection, 'close'>; stream: MediaStream; audio: HTMLAudioElement; id?: string; closingTimer?: ReturnType<typeof setTimeout> }

/** Start a company-context voice conversation without changing the text composer. */
export function HiveLiveVoiceButton({ sessionId, useInput, t }: Props) {
  const draft = useInput(value => value?.draft ?? '')
  const [state, setState] = useState<'idle' | 'connecting' | 'live'>('idle')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [caption, setCaption] = useState('')
  const [speakerMuted, setSpeakerMuted] = useState(false)
  const [micMuted, setMicMuted] = useState(false)
  const [micClosing, setMicClosing] = useState(false)
  const connection = useRef<VoiceConnection>()
  const activity = useRef<ReturnType<typeof observeVoiceActivity>>()
  const levels = useRef<VoiceLevels>({ user: 0, agent: 0 })
  const control = useRef<HTMLDivElement>(null)
  const [composer, setComposer] = useState<HTMLElement | null>(null)
  useEffect(() => { setComposer(control.current?.closest<HTMLElement>('[data-composer-card]') ?? null) }, [state])
  const ringback = useRef<() => void>()
  const stopRingback = () => { ringback.current?.(); ringback.current = undefined }
  const generation = useRef(0)
  const stop = useCallback(() => {
    ringback.current?.(); ringback.current = undefined
    activity.current?.stop(); activity.current = undefined
    generation.current++
    const current = connection.current; connection.current = undefined
    if (current?.closingTimer) clearTimeout(current.closingTimer)
    current?.stream.getTracks().forEach(track => track.stop())
    current?.peer.close()
    if (current) { current.audio.pause(); current.audio.srcObject = null }
    if (current?.id) void fetch('/api/hivemind/voice/stop', { method: 'POST', credentials: 'include', keepalive: true,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: current.id }) }).catch(() => {})
    setState('idle'); setCaption(''); setSpeakerMuted(false); setMicMuted(false); setMicClosing(false)
  }, [])
  useEffect(() => () => { stop() }, [sessionId, stop])
  const voiceStatus = useRef({ state, error, busy })
  voiceStatus.current = { state, error, busy }
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('hivemind:room-call-status', { detail: { sessionId, state, error, busy } }))
  }, [sessionId, state, error, busy])
  const toggleRef = useRef<() => Promise<void>>()
  useEffect(() => {
    const start = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string }>).detail
      if (detail?.sessionId !== sessionId) return
      event.preventDefault()
      // Start invitations cannot terminate an already connected call.
      if (voiceStatus.current.state === 'idle') void toggleRef.current?.()
    }
    const report = () => window.dispatchEvent(new CustomEvent('hivemind:room-call-status', { detail: { sessionId, ...voiceStatus.current } }))
    const request = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId) report()
    }
    window.addEventListener('hivemind:start-room-call', start)
    window.addEventListener('hivemind:room-call-status-request', request)
    report()
    return () => {
      window.removeEventListener('hivemind:start-room-call', start)
      window.removeEventListener('hivemind:room-call-status-request', request)
    }
  }, [sessionId])
  const toggle = async (alternate = false) => {
    if (state !== 'idle') { stop(); return }
    const ticket = ++generation.current
    stopRingback(); ringback.current = startCallRingback()
    setState('connecting'); setError(false); setBusy(false)
    let local: VoiceConnection | undefined
    let mayFallback = false
    let fallbackAttempted = false
    let everConnected = false
    const recover = async () => {
      if (!local || fallbackAttempted || generation.current !== ticket) return false
      fallbackAttempted = true; mayFallback = true; setState('connecting')
      local.peer.close()
      if (local.id) {
        await fetch('/api/hivemind/voice/stop', { method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: local.id }) }).catch(() => {})
        delete local.id
      }
      try {
        const fallback = await startGrokVoice(sessionId, local.stream, local.audio,
          () => { if (generation.current === ticket) setState('live') }, setCaption,
          (failed) => { if (generation.current === ticket) { stop(); setError(failed) } },
          () => { setMicMuted(true); setMicClosing(true) },
          () => { if (generation.current === ticket) stopRingback() })
        if (generation.current !== ticket) { fallback.close(); return false }
        if (typeof MediaStream !== 'undefined' && local.audio.srcObject instanceof MediaStream) activity.current?.remote(local.audio.srcObject)
        local.peer = fallback
        local.id = fallback.id
        return true
      } catch { return false }
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      if (generation.current !== ticket) { stream.getTracks().forEach(track => track.stop()); return }
      const peer = new RTCPeerConnection()
      const audio = new Audio(); audio.autoplay = true
      local = { peer, stream, audio }; connection.current = local
      activity.current = observeVoiceActivity(stream, (value) => {
        levels.current = value
        if (value.agent > 0 && generation.current === ticket) stopRingback()
      })
      if (alternate) {
        if (!await recover()) throw new Error('voice_fallback_unavailable')
        return
      }
      stream.getTracks().forEach(track => peer.addTrack(track, stream))
      peer.ontrack = (event) => {
        if (generation.current !== ticket) return
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
        activity.current?.remote(audio.srcObject as MediaStream)
        void audio.play().catch(() => { if (generation.current === ticket) { stop(); setError(true) } })
      }
      peer.onconnectionstatechange = () => {
        if (generation.current !== ticket) return
        if (peer.connectionState === 'connected') { everConnected = true; setState('live') }
        if (!mayFallback && peer.connectionState === 'failed' && !everConnected) void recover().then((recovered) => { if (!recovered && generation.current === ticket) { stop(); setError(true) } })
        else if (!mayFallback && ['failed', 'closed'].includes(peer.connectionState)) { stop(); setError(true) }
      }
      const events = peer.createDataChannel('oai-events')
      events.onmessage = (event) => {
        if (generation.current !== ticket) return
        try {
          const value = JSON.parse(event.data)
          if (['response.audio.delta', 'response.output_audio.delta'].includes(value.type) && typeof value.delta === 'string' && value.delta.length > 0) stopRingback()
          if (value.type === 'turn.done' && typeof value.turn?.transcript === 'string') setCaption(value.turn.transcript)
          if (value.type === 'error') { stop(); setError(true) }
        } catch { /* Ignore non-JSON provider transport frames. */ }
      }
      await peer.setLocalDescription(await peer.createOffer())
      const response = await fetch('/api/hivemind/voice/start', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, sdp: peer.localDescription?.sdp }), signal: AbortSignal.timeout(35000) })
      const value = await response.json() as {
        id?: string
        sdp?: string
        error?: string
        fallbackAllowed?: boolean
        closingAfterMs?: number
      }
      if (response.status === 409 && value.error === 'voice_already_active') setBusy(true)
      mayFallback = response.status >= 500 && value.fallbackAllowed === true
      if (!response.ok || !value.id || !value.sdp) throw new Error('voice_unavailable')
      local.id = value.id
      if (typeof value.closingAfterMs === 'number' && value.closingAfterMs >= 0) local.closingTimer = setTimeout(() => {
        if (generation.current !== ticket) return
        stream.getAudioTracks().forEach((track) => { track.enabled = false }); setMicMuted(true); setMicClosing(true)
      }, value.closingAfterMs)
      if (generation.current !== ticket) {
        void fetch('/api/hivemind/voice/stop', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: value.id }) })
        return
      }
      await peer.setRemoteDescription({ type: 'answer', sdp: value.sdp })
    } catch {
      if (generation.current === ticket && mayFallback && await recover()) return
      if (generation.current === ticket) { stop(); setError(true) }
      else { local?.stream.getTracks().forEach(track => track.stop()); local?.peer.close() }
    }
  }
  toggleRef.current = toggle
  // A typed draft retains the ordinary upward send arrow; ongoing voice keeps its end control.
  if (draft.trim() && state === 'idle') return null
  const label = busy ? t('voice.busy') : error ? t('voice.retry') : state === 'connecting' ? t('voice.connecting') : state === 'live' ? t('voice.end') : t('voice.start')
  return <div ref={control} className={css.control} data-hivemind-live-voice data-voice-active={state !== 'idle' || undefined}>
    <Tooltip label={label} side="top" delayMs={300}>
      <button type="button" className={css.button} aria-label={label} aria-pressed={state === 'live'} onClick={() => { void toggle() }}>
        {state !== 'idle' ? <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg> : <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden><path d="M3 8v4m3-7v10m4-13v16m4-13v10m3-7v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>}
      </button>
    </Tooltip>
    {state === 'idle' && <details className={css.options}>
      <summary aria-label={t('voice.options')}>⋯</summary>
      <button type="button" onClick={(event) => {
        event.currentTarget.closest('details')?.removeAttribute('open')
        void toggle(true)
      }}>{t('voice.alternate')}</button>
    </details>}
    {state !== 'idle' && (composer ? createPortal(<div className={css.callStrip} data-room-call-strip role="group" aria-label={label}>
      <button type="button" className={css.hangup} aria-label={t('voice.end')} onClick={stop}>
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden><path d="M3 14c4-5 14-5 18 0l-2 4-4-2v-3H9v3l-4 2-2-4Z" fill="currentColor" /></svg>
      </button>
      <CallColorWave levels={levels} />
      <span className={css.callLabel} role="status">{t(state === 'connecting' ? 'voice.connecting' : 'voice.listening')}</span>
      <details className={css.callOptions}><summary aria-label={t('voice.options')}><svg className={css.phone} width="20" height="20" viewBox="0 0 24 24" aria-hidden><path d="M5 3h4l2 5-3 2a16 16 0 0 0 6 6l2-3 5 2v4c0 2-2 3-4 2C9 19 5 15 3 7c-1-2 0-4 2-4Z" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></summary>
        <div className={css.callMenu}>
          <button type="button" aria-pressed={speakerMuted} onClick={() => {
            const audio = connection.current?.audio
            if (audio) { audio.muted = !speakerMuted; setSpeakerMuted(!speakerMuted) }
          }}>{t(speakerMuted ? 'voice.unmuteSpeaker' : 'voice.muteSpeaker')}</button>
          <button type="button" aria-pressed={micMuted} disabled={micClosing} onClick={() => {
            connection.current?.stream.getAudioTracks().forEach((track) => { track.enabled = micMuted })
            setMicMuted(!micMuted)
          }}>{t(micMuted ? 'voice.unmuteMic' : 'voice.muteMic')}</button>
        </div>
      </details>
    </div>, composer) : null)}
    {busy && <span role="status">{t('voice.busy')}</span>}
    {state !== 'idle' && <span className={css.caption} hidden>{caption || t(state === 'connecting' ? 'voice.connecting' : 'voice.listening')}</span>}
  </div>
}
