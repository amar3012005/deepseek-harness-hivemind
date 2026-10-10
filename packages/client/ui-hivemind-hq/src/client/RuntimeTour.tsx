/** Five quiet first-entry steps, in the native composer dock of the same Runtime room. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HqTourState, HqTourUpdate, HqTourUpdateResult, HqTourWakeResult } from '@deepseek-ai/dsh-hivemind-hq-runtime/client'
import { tourAssets } from './tour-assets.ts'
import css from './RuntimeTour.module.css'
import { tourEn, type TourKey } from './tour-copy.ts'

export interface RuntimeTourProps {
  readonly t?: (key: TourKey) => string
  readonly sessionId: SessionId
  readonly load: (id: SessionId) => Promise<RemoteResult<HqTourState>>
  readonly checkpoint: (id: SessionId, request: HqTourUpdate) => Promise<RemoteResult<HqTourUpdateResult>>
  readonly wake: (id: SessionId) => Promise<RemoteResult<HqTourWakeResult>>
  readonly resume: (id: SessionId) => Promise<RemoteResult<HqTourWakeResult>>
  readonly subscribe: (id: SessionId, callback: () => void) => () => void
}
const steps = [
  { image: 'sleeping', eyebrow: 'tour.0.eyebrow', title: 'tour.0.title',
    text: 'tour.0.text' },
  { image: 'introduction', eyebrow: 'tour.1.eyebrow', title: 'tour.1.title',
    text: 'tour.1.text' },
  { image: 'pointing', eyebrow: 'tour.2.eyebrow', title: 'tour.2.title',
    text: 'tour.2.text' },
  { image: 'explaining', eyebrow: 'tour.3.eyebrow', title: 'tour.3.title',
    text: 'tour.3.text' },
  { image: 'ready', eyebrow: 'tour.4.eyebrow', title: 'tour.4.title',
    text: 'tour.4.text' },
] as const

/** Local progress and Remote presentation writes never access the composer draft.
 * @param props - Scoped native actions and localized presentation.
 * @returns The walkthrough, a retained wake entry, or nothing after confirmed awakening.
 */
export function RuntimeTour({ sessionId, load, checkpoint, wake, resume, subscribe, t = key => tourEn[key] }: RuntimeTourProps) {
  const [state, setState] = useState<HqTourState | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const epoch = useRef(0)
  const generation = useRef(0)
  const busy = useRef(false)
  const initial = useRef(true)
  const mounted = useRef(false)
  const card = useRef<HTMLElement>(null)
  const refresh = useCallback(async () => {
    const revision = ++generation.current
    try {
      const result = await load(sessionId)
      if (!mounted.current || revision !== generation.current) return
      if (!result.ok) throw new Error('tour unavailable')
      setState(result.value)
      setLoadError(false)
      if (initial.current) {
        setExpanded(result.value.presentation === 'active' && result.value.awakening === 'sleeping')
        initial.current = false
      }
      if (result.value.awakening === 'awakened') setExpanded(false)
    } catch { if (mounted.current && revision === generation.current) setLoadError(true) }
  }, [load, sessionId])
  useEffect(() => {
    mounted.current = true; ++epoch.current; initial.current = true; busy.current = false
    setState(null); setError(null); setPending(false); setLoadError(false)
    void refresh()
    const dispose = subscribe(sessionId, () => { if (!busy.current) void refresh() })
    return () => { mounted.current = false; ++epoch.current; ++generation.current; dispose() }
  }, [refresh, sessionId, subscribe])
  // Poll only while first awakening is pending, since a restored turn can finish
  // between the event subscription and the first authoritative read.
  useEffect(() => {
    if (!state || ['sleeping', 'awakened'].includes(state.awakening)) return
    const timer = setInterval(() => { if (!busy.current) void refresh() }, 5000)
    return () => clearInterval(timer)
  }, [state?.awakening, refresh])
  useEffect(() => {
    if (!expanded) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    card.current?.focus({ preventScroll: true })
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [expanded])
  const save = async (step: number, presentation: HqTourUpdate['presentation']) => {
    if (!state || busy.current) return
    const lifetime = epoch.current
    busy.current = true; ++generation.current; setPending(true); setError(null)
    try {
      const result = await checkpoint(sessionId, { expectedRevision: state.revision, step, presentation })
      if (!result.ok) throw new Error('checkpoint unavailable')
      if (!mounted.current || lifetime !== epoch.current) return
      setState(result.value.ok ? result.value.value : result.value.current)
      if (!result.value.ok) setError(t('tour.conflict'))
      else setExpanded(presentation === 'active')
    } catch { if (mounted.current && lifetime === epoch.current) setError(t('tour.saveFailed')) }
    finally { if (lifetime === epoch.current) { busy.current = false; if (mounted.current) setPending(false) } }
  }
  const awaken = async () => {
    if (!state || busy.current) return
    const lifetime = epoch.current
    busy.current = true; ++generation.current; setPending(true); setError(null)
    try {
      const result = await (state.canResume ? resume(sessionId) : wake(sessionId))
      if (!result.ok) throw new Error('wake unavailable')
      if (!mounted.current || lifetime !== epoch.current) return
      setState(result.value.state); setExpanded(false)
    } catch {
      if (mounted.current && lifetime === epoch.current) setError(t('tour.wakeFailed'))
    } finally { if (lifetime === epoch.current) { busy.current = false; if (mounted.current) { setPending(false); void refresh() } } }
  }
  if (state?.awakening === 'awakened') return null
  if (!state) return <section className={css.container} data-runtime-tour="" aria-label={t('tour.label')}><div className={css.banner}>
    <img src={tourAssets.sleeping} alt="" /><div><strong>{t('tour.0.title')}</strong><p role="status">{loadError ? t('tour.loadFailed') : t('tour.loading')}</p></div>
    {loadError ? <button className={css.retry} onClick={() => { setLoadError(false); void refresh() }}>{t('tour.retry')}</button> : null}
  </div></section>
  const step = steps[Math.min(4, Math.max(0, state.step))] ?? steps[0]
  const sleeping = state.awakening === 'sleeping'
  const status = sleeping ? t('tour.sleeping')
    : state.awakening === 'accepted' ? t('tour.accepted')
      : state.awakening === 'blocked' ? t('tour.blocked')
        : state.running ? t('tour.exploring')
          : t('tour.unfinished')
  return <section className={css.container} data-runtime-tour="" data-runtime-tour-expanded={expanded || undefined} data-runtime-tour-awakening={state.awakening} aria-label={t('tour.label')}>
    {expanded ? <section className={css.card} ref={card} tabIndex={-1} aria-label={t('tour.walkthrough')}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); void save(state.step, 'dismissed') } }}>
      <div className={css.art} data-pose={step.image}><img src={tourAssets[step.image]} alt={t('tour.alt')} /></div>
      <div className={css.copy}>
        <div className={css.eyebrow}>{t(step.eyebrow)}</div>
        <h2>{t(step.title)}</h2><p>{t(step.text)}</p>
        <div className={css.dots} aria-label={t('tour.step').replace('{current}', String(state.step + 1))}>{steps.map((_, index) => <span key={index} data-current={index === state.step} />)}</div>
        <div className={css.actions}>
          {state.step > 0 ? <button disabled={pending} onClick={() => void save(state.step - 1, 'active')}>{t('tour.back')}</button> : null}
          <button disabled={pending} onClick={() => void save(state.step, 'dismissed')}>{t('tour.later')}</button>
          {state.step < 4 ? <button className={css.primary} disabled={pending} onClick={() => void save(state.step + 1, 'active')}>{t('tour.next')} <span aria-hidden="true">→</span></button>
            : <><button disabled={pending} onClick={() => void save(4, 'completed')}>{t('tour.finish')}</button><button className={css.primary} disabled={pending || state.running || !sleeping} onClick={() => void awaken()}>{pending ? t('tour.checking') : t('tour.wake')}</button></>}
        </div>
      </div>
    </section> : <div className={css.banner}>
      <img src={tourAssets.sleeping} alt="" /><div><strong>{sleeping ? t('tour.bringAlive') : t('tour.awakening')}</strong><p role="status">{status}</p></div>
      <div className={css.actions}><button disabled={pending} onClick={() => { setExpanded(true); setError(null) }}>{state.presentation === 'completed' ? t('tour.view') : t('tour.continue')}</button>
        <button className={css.primary} disabled={pending || state.running} onClick={() => void awaken()}>{pending ? t('tour.checking') : sleeping ? t('tour.wake') : state.canResume ? t('tour.resume') : t('tour.check')}</button></div>
    </div>}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    {loadError ? <div className={css.error} role="status">{t('tour.refreshFailed')} <button className={css.retry} onClick={() => void refresh()}>{t('tour.retry')}</button></div> : null}
  </section>
}
