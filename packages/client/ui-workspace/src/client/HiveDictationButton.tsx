import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './HiveDictationButton.module.css'

type DictationState = 'idle' | 'recording' | 'transcribing'
type Props = PropsRuntime<'conversation.input.left'> & PropsLocale<'workspace'>

declare global {
  interface Window { __HIVEMIND_DICTATION_ENDPOINT__?: string }
}

/** HIVE-only speech input composed into the native resident composer. */
export function HiveDictationButton({ useInput, inputActions, t }: Props) {
  const draft = useInput(value => value?.draft ?? '')
  const [state, setState] = useState<DictationState>('idle')
  const recorder = useRef<MediaRecorder>()
  const stream = useRef<MediaStream>()
  const chunks = useRef<Blob[]>([])

  const cleanup = useCallback(() => {
    stream.current?.getTracks().forEach((track) => { track.stop() })
    stream.current = undefined
    recorder.current = undefined
    chunks.current = []
  }, [])

  const transcribe = useCallback(async (blob: Blob) => {
    if (blob.size < 1024) { setState('idle'); return }
    setState('transcribing')
    try {
      const endpoint = window.__HIVEMIND_DICTATION_ENDPOINT__
      if (endpoint === undefined) throw new Error('Speech input is unavailable')
      const response = await fetch(`${endpoint}?diarize=false&prompt=${encodeURIComponent('Spoken message to an AI assistant.')}`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob,
      })
      const value = await response.json() as { text?: string; transcript?: string; message?: string }
      if (!response.ok) throw new Error(value.message ?? 'Transcription failed')
      const text = (value.text ?? value.transcript ?? '').trim()
      if (text !== '') inputActions?.setDraft(`${draft}${draft.trim() === '' ? '' : ' '}${text}`)
    } catch (error) {
      console.warn('hivemind dictation failed:', error)
    } finally {
      cleanup()
      setState('idle')
    }
  }, [cleanup, draft, inputActions])

  const toggle = useCallback(async () => {
    if (state === 'recording') { recorder.current?.stop(); return }
    if (state !== 'idle') return
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm'
      const next = new MediaRecorder(nextStream, { mimeType })
      stream.current = nextStream
      recorder.current = next
      chunks.current = []
      next.ondataavailable = (event) => { if (event.data.size > 0) chunks.current.push(event.data) }
      next.onstop = () => { void transcribe(new Blob(chunks.current, { type: mimeType })) }
      next.start(250)
      setState('recording')
    } catch (error) {
      cleanup()
      console.warn('hivemind microphone unavailable:', error)
    }
  }, [cleanup, state, transcribe])

  useEffect(() => cleanup, [cleanup])
  const label = state === 'recording' ? t('dictation.stop')
    : state === 'transcribing' ? t('dictation.transcribing') : t('dictation.start')
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
