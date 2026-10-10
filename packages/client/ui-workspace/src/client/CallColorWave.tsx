/** Official voice-glow visual, driven by existing call audio rather than a second microphone. */
import { useCallback, useRef } from 'react'
import { VoiceBeam } from 'voice-glow'
import type { VoiceLevels } from './voice-activity.ts'
import css from './HiveLiveVoiceButton.module.css'

export function CallColorWave({ levels }: { levels: React.MutableRefObject<VoiceLevels> }) {
  const window = useRef<HTMLDivElement>(null)
  const level = useCallback(() => {
    const value = Math.max(levels.current.user, levels.current.agent)
    // A sampled getter avoids React renders per audio frame. Silence hides the glow.
    window.current?.toggleAttribute('data-audio-active', value > 0)
    return value
  }, [levels])
  return <div ref={window} className={css.waveWindow} aria-hidden="true">
    <VoiceBeam type="pill" level={level} idle={0} release={0.24} attack={0.08}
      theme="dark" colorVariant="colorful" scale={0.7} borderRadius={8}
      distortion={0} staticColors flow={38} glowSize={0.55} reach={1.2}>
      <div className={css.waveSurface} />
    </VoiceBeam>
  </div>
}
