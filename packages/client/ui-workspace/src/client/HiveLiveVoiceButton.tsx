/** Live voice media is owned by this composer button and released on navigation. */
import { createPortal } from 'react-dom'
import { CallColorWave } from './CallColorWave.tsx'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { observeVoiceActivity, type VoiceLevels } from './voice-activity.ts'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { startCallRingback } from './call-ringback.ts'
import css from './HiveLiveVoiceButton.module.css'

type Props = Pick<PropsRuntime<'conversation.input.right'>, 'sessionId' | 'useInput'> & Partial<Pick<PropsRuntime<'conversation.input.right'>, 'useSession'>> & PropsLocale<'workspace'>
interface VoiceConnection { peer: Pick<RTCPeerConnection, 'close'>; stream: MediaStream; audio: HTMLAudioElement; id?: string; closingTimer?: ReturnType<typeof setTimeout> }

/** Start a company-context voice conversation without changing the text composer. */
export function HiveLiveVoiceButton({ sessionId, useInput, useSession, t }: Props) {
  const running = useSession?.(snapshot => snapshot.running) ?? false
  const draft = useInput(value => value?.draft ?? '')
  const [state, setState] = useState<'idle' | 'connecting' | 'live'>('idle')
  const [error, setError] = useState(false)
  const errorTitle = useId()
  const [busy, setBusy] = useState(false)
  const [caption, setCaption] = useState('')
  const [speakerMuted, setSpeakerMuted] = useState(false)
  const [micMuted, setMicMuted] = useState(false)
  const [micClosing, setMicClosing] = useState(false)
  const connection = useRef<VoiceConnection>()
  const control = useRef<HTMLDivElement>(null)
  const [composer, setComposer] = useState<HTMLElement | null>(null)
  useEffect(() => { setComposer(control.current?.closest<HTMLElement>('[data-composer-card]') ?? null) }, [state])
  const levels = useRef<VoiceLevels>({ user: 0, agent: 0 })
  const activity = useRef<ReturnType<typeof observeVoiceActivity>>()
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
      window.dispatchEvent(new CustomEvent('hivemind:room-call-status', { detail: { sessionId, state: 'idle', error: false, busy: false } }))
    }
  }, [sessionId])
  const toggle = async () => {
    if (state !== 'idle') { stop(); return }
    const ticket = ++generation.current
    stopRingback(); ringback.current = startCallRingback()
    setState('connecting'); setError(false); setBusy(false)
    let local: VoiceConnection | undefined
    try {
      // A dismissed/unanswered microphone prompt must not leave Connecting forever.
      // Late permission results release their tracks and never start a call.
      let permissionExpired = false
      let permissionTimer: ReturnType<typeof setTimeout> | undefined
      const microphone = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }).then((stream) => {
        if (permissionExpired) stream.getTracks().forEach(track => track.stop())
        return stream
      })
      let stream: MediaStream
      try {
        stream = await Promise.race([microphone, new Promise<never>((_, reject) => {
          permissionTimer = setTimeout(() => { permissionExpired = true; reject(new Error('microphone_permission_timeout')) }, 20000)
        })])
      } finally { if (permissionTimer) clearTimeout(permissionTimer) }
      if (generation.current !== ticket) { stream.getTracks().forEach(track => track.stop()); return }
      const peer = new RTCPeerConnection()
      const audio = new Audio(); audio.autoplay = true
      local = { peer, stream, audio }; connection.current = local
      activity.current = observeVoiceActivity(stream, (value) => {
        levels.current = value
        if (value.agent > 0 && generation.current === ticket) stopRingback()
      }, typeof location !== 'undefined' && location.protocol === 'capacitor:')
      // Keep one audible output; the native Web Audio speaker owns mute.
      audio.muted = activity.current.playsThroughWebAudio
      stream.getTracks().forEach(track => peer.addTrack(track, stream))
      peer.ontrack = (event) => {
        if (generation.current !== ticket) return
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
        activity.current?.remote(audio.srcObject as MediaStream)
        void audio.play().catch(() => { if (generation.current === ticket) { stop(); setError(true) } })
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
        accountConnectionRequired?: boolean
        closingAfterMs?: number
      }
      if (response.status === 409 && value.error === 'voice_already_active') setBusy(true)
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
      if (generation.current === ticket) { stop(); setError(true) }
      else { local?.stream.getTracks().forEach(track => track.stop()); local?.peer.close() }
    }
  }
  toggleRef.current = toggle
  // A typed draft retains the ordinary upward send arrow; ongoing voice keeps its end control.
  if ((draft.trim() || running) && state === 'idle' && !error) return null
  const label = busy ? t('voice.busy') : error ? t('voice.retry') : state === 'connecting' ? t('voice.connecting') : state === 'live' ? t('voice.end') : t('voice.start')
  const activeControls = <div className={composer ? css.callStrip : css.callControls} data-room-call-strip role="group" aria-label={label}>
    <Tooltip label={t('voice.end')} side="top" delayMs={300}>
      <button type="button" className={css.hangup} aria-label={t('voice.end')} onClick={stop}>
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden><path d="M4 15v-3c4-4 12-4 16 0v3l-5-1v-3M9 11v3l-5 1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </Tooltip>
    <CallColorWave levels={levels} />
    <span className={css.callLabel} role="status">{t(state === 'connecting' ? 'voice.connecting' : 'voice.listening')}</span>
    <Tooltip label={t(speakerMuted ? 'voice.unmuteSpeaker' : 'voice.muteSpeaker')} side="top" delayMs={300}>
      <button type="button" className={css.utility} aria-label={t(speakerMuted ? 'voice.unmuteSpeaker' : 'voice.muteSpeaker')} aria-pressed={speakerMuted} onClick={() => {
        const audio = connection.current?.audio
        if (!audio) return
        if (activity.current?.playsThroughWebAudio) activity.current.setSpeakerMuted(!speakerMuted)
        else audio.muted = !speakerMuted
        setSpeakerMuted(!speakerMuted)
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden><path d="M3 9h4l5-4v14l-5-4H3Z" fill="currentColor" /><path d={speakerMuted ? 'm16 9 5 6m0-6-5 6' : 'M16 8c3 2 3 6 0 8m3-11c5 4 5 10 0 14'} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </Tooltip>
    <Tooltip label={t(micMuted ? 'voice.unmuteMic' : 'voice.muteMic')} side="top" delayMs={300}>
      <button type="button" className={css.utility} aria-label={t(micMuted ? 'voice.unmuteMic' : 'voice.muteMic')} aria-pressed={micMuted} disabled={micClosing} onClick={() => {
        connection.current?.stream.getAudioTracks().forEach((track) => { track.enabled = micMuted })
        setMicMuted(!micMuted)
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden><rect x="9" y="3" width="6" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3m-3 0h6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />{micMuted && <path d="m3 3 18 18" stroke="currentColor" strokeWidth="1.7" />}</svg>
      </button>
    </Tooltip>

  </div>
  return <div ref={control} className={css.control} data-hivemind-live-voice data-voice-active={state !== 'idle' || undefined}>
    {state === 'idle' ? <Tooltip label={label} side="top" delayMs={300}>
      <button type="button" className={css.button} aria-label={label} onClick={() => { void toggle() }}>
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden><path d="M4 10v4m4-7v10m4-14v18m4-14v10m4-7v4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
      </button>
    </Tooltip> : (composer ? createPortal(activeControls, composer) : activeControls)}
    {error && createPortal(<div className={css.failureOverlay}>
      <section className={css.failureCard} role="alertdialog" aria-modal="true" aria-labelledby={errorTitle} onKeyDown={(event) => {
        if (event.key === 'Escape') setError(false)
        if (event.key === 'Tab') {
          const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button')
          const first = buttons[0], last = buttons[buttons.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
        <div className={css.failureIcon} aria-hidden>↻</div>
        <h2 id={errorTitle}>{t(busy ? 'voice.busy' : 'voice.connectionUnavailable')}</h2>
        <p>{t('voice.connectionRetryHint')}</p>
        <div className={css.failureActions}>
          <button type="button" autoFocus onClick={() => setError(false)}>{t('voice.dismiss')}</button>
          <button type="button" className={css.retryAction} onClick={() => { void toggle() }}>{t('voice.tryAgain')}</button>
        </div>
      </section>
    </div>, document.body)}
    {busy && <span role="status">{t('voice.busy')}</span>}
    {state !== 'idle' && <span className={css.caption} hidden>{caption || t(state === 'connecting' ? 'voice.connecting' : 'voice.listening')}</span>}
  </div>
}
