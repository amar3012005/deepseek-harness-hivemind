// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HiveDictationButton } from '../src/client/HiveDictationButton.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}))

class Recorder {
  static instance: Recorder
  static isTypeSupported = vi.fn(() => true)
  state: RecordingState = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null

  constructor() { Recorder.instance = this }
  start(): void { this.state = 'recording' }
  stop(): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) } as BlobEvent)
    this.state = 'inactive'
    this.onstop?.()
  }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, '__HIVEMIND_TRANSCRIBE_AUDIO__')
  vi.restoreAllMocks()
})

describe('HIVE native composer dictation', () => {
  it('records through the host bridge and appends the transcript to the native draft', async () => {
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: Recorder })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    })
    window.__HIVEMIND_TRANSCRIBE_AUDIO__ = vi.fn(async () => 'spoken words')
    const setDraft = vi.fn()
    const useInput = (selector: (value: { draft: string }) => unknown) => selector({ draft: 'Existing' })

    render(<HiveDictationButton useInput={useInput as never} inputActions={{ setDraft } as never}
      t={((key: string) => key) as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'dictation.start' }))
    await waitFor(() => { expect(screen.getByRole('status', { name: 'dictation.stop' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'dictation.stop' }))

    await waitFor(() => { expect(setDraft).toHaveBeenCalledWith('Existing spoken words') })
    expect(window.__HIVEMIND_TRANSCRIBE_AUDIO__).toHaveBeenCalledOnce()
  })
})
