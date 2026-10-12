/** Decorative generation animation; percentage is estimated, never provider-reported. */
import { Component, type ReactNode, useEffect, useState } from 'react'
import { ImageGeneration } from 'img-fx'
import css from './OperatingRun.module.css'

class AnimationBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override render() { return this.state.failed ? <div className={css.imageAnimationFallback} /> : this.props.children }
}

/** Animate active image or video work while capping an elapsed-time estimate below completion. */
export function ImageProgress({ startedAt, label }: { startedAt?: number | undefined; label: string }) {
  const [now, setNow] = useState(Date.now)
  const [reduced, setReduced] = useState(true)
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(motion.matches)
    update(); motion.addEventListener('change', update)
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(timer); motion.removeEventListener('change', update) }
  }, [])
  const elapsed = Math.max(0, now - (startedAt ?? now))
  const percent = Math.min(90, Math.max(1, Math.floor(90 * (1 - Math.exp(-elapsed / 90000)))))
  return <div className={css.imageProgress}>
    <AnimationBoundary>
      <ImageGeneration preset="sweep-gradient" images={[]} autoReveal={false} paused={reduced} borderRadius={20} style={{ width: 280, height: 280, maxWidth: '100%' }}>
        <div className={css.imageAnimationCanvas} style={{ width: 280, height: 280, maxWidth: '100%', borderRadius: 20 }} aria-hidden="true" />
      </ImageGeneration>
    </AnimationBoundary>
    <div className={css.imageProgressLabel}>{label} · {percent}%</div>
    <progress className={css.imageProgressBar} value={percent} max={100} aria-label={label} />
  </div>
}
