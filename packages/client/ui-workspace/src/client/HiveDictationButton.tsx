import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './HiveDictationButton.module.css'

type DictationState = 'idle' | 'recording' | 'transcribing'
type Props = PropsRuntime<'conversation.input.left'> & PropsLocale<'workspace'>

declare global {
  interface Window { __HIVEMIND_TRANSCRIBE_AUDIO__?: (blob: Blob) => Promise<string> }
}

/** HIVE-only speech input composed into the native resident composer. */
export function HiveDictationButton({ useInput, inputActions, t }: Props) {
  const draft = useInput(value => value?.draft ?? '')
  const [state, setState] = useState<DictationState>('idle')
  const [error, setError] = useState<string>()
  const recorder = useRef<MediaRecorder>()
  const stream = useRef<MediaStream>()
  const chunks = useRef<Blob[]>([])
  const draftRef = useRef(draft)
  draftRef.current = draft

  const cleanup = useCallback(() => {
    stream.current?.getTracks().forEach((track) => { track.stop() })
    stream.current = undefined
    recorder.current = undefined
    chunks.current = []
  }, [])

  const transcribe = useCallback(async (blob: Blob) => {
    if (blob.size < 1024) { setState('idle'); return }
    setState('transcribing')
    setError(undefined)
    try {
      const send = window.__HIVEMIND_TRANSCRIBE_AUDIO__
      if (send === undefined) throw new Error('Speech input is unavailable')
      const text = (await send(blob)).trim()
      if (text === '') throw new Error('No speech detected')
      const currentDraft = draftRef.current
      inputActions?.setDraft(`${currentDraft}${currentDraft.trim() === '' ? '' : ' '}${text}`)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Transcription failed'
      setError(message)
      console.warn('hivemind dictation failed:', cause)
    } finally {
      cleanup()
      setState('idle')
    }
  }, [cleanup, inputActions])

  const toggle = useCallback(async () => {
    if (state === 'recording') { recorder.current?.stop(); return }
    if (state !== 'idle') return
    try {
      setError(undefined)
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find(value => MediaRecorder.isTypeSupported(value))
      const next = mimeType === undefined
        ? new MediaRecorder(nextStream)
        : new MediaRecorder(nextStream, { mimeType })
      stream.current = nextStream
      recorder.current = next
      chunks.current = []
      next.ondataavailable = (event) => { if (event.data.size > 0) chunks.current.push(event.data) }
      next.onstop = () => {
        const type = next.mimeType || mimeType || chunks.current[0]?.type || 'audio/webm'
        void transcribe(new Blob(chunks.current, { type }))
      }
      next.start(250)
      setState('recording')
    } catch (cause) {
      cleanup()
      const message = cause instanceof Error ? cause.message : 'Microphone permission denied'
      setError(message)
      console.warn('hivemind microphone unavailable:', cause)
    }
  }, [cleanup, state, transcribe])

  const cancel = useCallback(() => {
    const active = recorder.current
    if (active !== undefined) {
      active.onstop = null
      if (active.state !== 'inactive') active.stop()
    }
    cleanup()
    setState('idle')
  }, [cleanup])

  useEffect(() => cleanup, [cleanup])
  const label = error ?? (state === 'recording' ? t('dictation.stop')
    : state === 'transcribing' ? t('dictation.transcribing') : t('dictation.start')
  )

  if (state !== 'idle') return <div className={css.recorder} role="status" aria-label={label}>
    <button type="button" className={css.cancel} aria-label={t('dictation.cancel')} onClick={cancel}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
    <span className={clsx(css.waveform, state === 'transcribing' && css.transcribing)} aria-hidden>
      {Array.from({ length: 28 }, (_, index) => <i key={index} style={{
        '--wave-index': index,
        '--wave-height': `${3 + ((index * 7) % 18)}px`,
      } as React.CSSProperties} />)}
    </span>
    <button type="button" className={css.stop} aria-label={label} disabled={state === 'transcribing'} onClick={() => { void toggle() }}>
      {state === 'transcribing'
        ? <span className={css.spinner} />
        : <span className={css.stopSquare} />}
    </button>
  </div>

  return <Tooltip label={label} side="top" delayMs={400}>
    <button
      type="button"
      className={clsx(css.button, state === 'recording' && css.recording)}
      aria-label={label}
      aria-pressed={state === 'recording'}
      disabled={state === 'transcribing'}
      onClick={() => { void toggle() }}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <rect x="5.25" y="1.5" width="5.5" height="8" rx="2.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  </Tooltip>
}
