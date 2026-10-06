import { useEffect, useRef, type ReactNode } from 'react'
import css from './MobileAddSheet.module.css'

const paths: Record<string, string> = {
  photo: 'M3 3h18v18H3zM3 16l5-5 5 5 3-3 5 5M15 8h2',
  camera: 'M4 6h4l2-3h4l2 3h4v15H4zM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  file: 'M5 3h9l5 5v13H5zM14 3v5h5M8 12h8M8 16h8',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0m-1 5 6 6',
  research: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18',
  notes: 'M9 2h6v13H9zM5 11v2a7 7 0 0 0 14 0v-2M12 20v2',
  apps: 'M8 3v6m8-6v6M5 9h14v4a7 7 0 0 1-14 0zM12 20v2',
}
function SheetIcon({ kind }: { kind: string }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>
}
export function MobileAddSheet({ close, pick, canAttach, chooseMode, commands, controls }: {
  close: () => void
  pick: (kind: 'photo' | 'camera' | 'file') => void
  canAttach: boolean
  chooseMode: (mode: 'search' | 'research') => void
  commands?: (() => void) | undefined
  controls?: ReactNode
}) {
  const panel = useRef<HTMLElement>(null)
  const handingOff = useRef(false)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const items = () => [...(panel.current?.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex="0"]') ?? [])]
      .filter(element => !element.hasAttribute('disabled'))
    items()[0]?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const buttons = items(); const first = buttons[0]; const last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      if (!handingOff.current) previous?.focus()
    }
  }, [close])
  return <div className={css.overlay}>
    <button className={css.backdrop} type="button" aria-label="Close add to chat" onClick={close} />
    <section ref={panel} className={css.sheet} role="dialog" aria-modal="true" aria-label="Add to this chat">
      <div className={css.handle} aria-hidden="true" />
      <header><strong>Add to this chat</strong><button type="button" aria-label="Close" onClick={close}>×</button></header>
      <div className={css.files}>{(['photo', 'camera', 'file'] as const).map(kind =>
        <button key={kind} type="button" disabled={!canAttach}
          title={canAttach ? undefined : 'File upload is not available in this chat yet'} onClick={() => pick(kind)}>
          <span><SheetIcon kind={kind} /></span>{kind[0]?.toUpperCase()}{kind.slice(1)}
        </button>)}</div>
      <small>MODES</small>
      <button className={css.action} type="button" onClick={() => chooseMode('search')}>
        <span><SheetIcon kind="search" /></span><span><strong>Search</strong><small>Prepare a focused search request</small></span>
      </button>
      <button className={css.action} type="button" onClick={() => chooseMode('research')}>
        <span><SheetIcon kind="research" /></span>
        <span><strong>Deep Research</strong><small>Ask for a multi-source report</small></span>
      </button>
      <small>ADD</small>
      <a className={css.action} href={`/hivemind/m/meeting-notes?native_chat_return=${encodeURIComponent(window.location.pathname)}`}>
        <span><SheetIcon kind="notes" /></span><span><strong>Start taking meeting notes</strong><small>Open AI Meeting Notes</small></span>
      </a>
      <button className={css.action} type="button" onClick={() => {
        handingOff.current = true
        close(); queueMicrotask(() => window.dispatchEvent(new Event('hivemind:mobile-connectors')))
      }}>
        <span><SheetIcon kind="apps" /></span>
        <span><strong>Connectors &amp; sources</strong><small>Choose a connected app or connect a new one</small></span>
      </button>
      {controls && <details className={css.options}><summary>Chat options</summary><div>{controls}</div></details>}
      {commands && <button className={css.action} type="button" onClick={commands}>
        <span>/</span><span><strong>More actions</strong><small>Native chat commands</small></span>
      </button>}
    </section>
  </div>
}
