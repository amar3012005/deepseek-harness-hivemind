/** Direct source iframe in the existing Preview, with an honest external fallback. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HivemindConnectKey } from './locales.ts'
import { sourceUrl, websiteSources, type WebsiteSource } from './website-sources.ts'
import css from './HyperagentEmployee.module.css'
type Translate = (key: HivemindConnectKey) => string
export function WebsitePreview({ sources, selected, select, t }: {
  sources: readonly WebsiteSource[]
  selected: WebsiteSource
  select: (url: string) => void
  t: Translate
}) {
  const [failed, setFailed] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    setFailed(false)
    const element = frame.current
    const fail = () => { setFailed(true) }
    element?.addEventListener('error', fail)
    return () => { element?.removeEventListener('error', fail) }
  }, [selected.url])
  const url = sourceUrl(selected.url)
  if (url === undefined) return null
  return <article data-website-preview>
    <div className={css.workbenchActions}>
      <select aria-label={t('website.select')} value={url} onChange={event => select(event.target.value)}>
        {sources.map(source => <option key={source.url} value={source.url}>{source.title}{source.visited ? ' · Visited' : ' · Search result'}</option>)}
      </select>
      <a href={url} target="_blank" rel="noopener noreferrer">{t('website.open')}</a>
    </div>
    {failed && <p role="alert" className={css.workbenchPath}>{t('website.failed')}</p>}
    {!failed && <iframe ref={frame} key={url} className={css.workbenchPdf} title={t('website.title')} src={url}
      sandbox="allow-scripts" referrerPolicy="no-referrer" />}
  </article>
}
/** Only newly received successful receipts open Preview, never initial history replay. */
export function WebsitePreviewUpdates({ events, open }: {
  events: { subscribe(listener: () => void): () => void; getSnapshot(): SessionEventWindow }
  open: (url: string) => void
}) {
  const window = useSyncExternalStore(listener => events.subscribe(listener), () => events.getSnapshot())
  const latest = websiteSources(window).filter(source => source.visited)
    .sort((a, b) => (a.visitedSeq ?? a.seq) - (b.visitedSeq ?? b.seq)).at(-1)
  const last = useRef({ events, seq: latest?.visitedSeq ?? latest?.seq ?? -1 })
  useEffect(() => {
    if (last.current.events !== events) {
      last.current = { events, seq: latest?.visitedSeq ?? latest?.seq ?? -1 }
      return
    }
    if (latest === undefined || (latest.visitedSeq ?? latest.seq) <= last.current.seq) return
    last.current.seq = latest.visitedSeq ?? latest.seq
    open(latest.url)
  }, [events, latest?.seq, latest?.url, open])
  return null
}
export function WebsiteSourceCard({ sources, open, t }: { sources: readonly WebsiteSource[]; open: (url: string) => void; t: Translate }) {
  return <div data-website-source-card className={css.workbenchActions}>
    {sources.map(source => <button key={source.url} type="button" className={css.workbenchOpen} onClick={() => open(source.url)}>
      {t('website.preview')} · {source.title}
    </button>)}
  </div>
}
