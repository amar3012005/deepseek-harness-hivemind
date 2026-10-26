// Phone "+" sheet for Brain chat: attachments, search/research modes, connected
// sources and the chat options (access, plan, model) that the composer row
// keeps on desktop. Labels come from the locale dictionary through `t`.

import { useEffect, useRef, type ReactNode } from 'react'
import type { ComposerBarProps } from '../contract/slots.ts'
import css from './MobileAddSheet.module.css'

type SheetKind = 'photo' | 'camera' | 'file' | 'search' | 'research' | 'apps'

const paths: Record<SheetKind, string> = {
  photo: 'M3 3h18v18H3zM3 16l5-5 5 5 3-3 5 5M15 8h2',
  camera: 'M4 6h4l2-3h4l2 3h4v15H4zM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  file: 'M5 3h9l5 5v13H5zM14 3v5h5M8 12h8M8 16h8',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0m-1 5 6 6',
  research: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18',
  apps: 'M8 3v6m8-6v6M5 9h14v4a7 7 0 0 1-14 0zM12 20v2',
}

function SheetIcon({ kind }: { kind: SheetKind }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>
}

export interface MobileAddSheetProps {
  t: ComposerBarProps['t']
  close: () => void
  pick: (kind: 'photo' | 'camera' | 'file') => void
  canAttach: boolean
  chooseMode: (mode: 'search' | 'research') => void
  commands?: (() => void) | undefined
  controls?: ReactNode
}

/** Modal bottom sheet: focus moves in on open, Escape and the backdrop close it, Tab cycles within it. */
export function MobileAddSheet({ t, close, pick, canAttach, chooseMode, commands, controls }: MobileAddSheetProps) {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const items = () => [...(panel.current?.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex="0"]') ?? [])]
      .filter(element => !element.hasAttribute('disabled'))
    items()[0]?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const buttons = items()
        const first = buttons[0]
        const last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      previous?.focus()
    }
  }, [close])
  const fileKinds = ['photo', 'camera', 'file'] as const
  return <div className={css.overlay}>
    <button className={css.backdrop} type="button" aria-label={t('mobileAdd.backdrop')} onClick={close} />
    <section ref={panel} className={css.sheet} role="dialog" aria-modal="true" aria-label={t('mobileAdd.title')}>
      <div className={css.handle} aria-hidden="true" />
      <header><strong>{t('mobileAdd.title')}</strong>
        <button type="button" aria-label={t('mobileAdd.close')} onClick={close}>×</button></header>
      <div className={css.files}>{fileKinds.map(kind =>
        <button key={kind} type="button" disabled={!canAttach}
          title={canAttach ? undefined : t('mobileAdd.fileUnavailable')} onClick={() => { pick(kind) }}>
          <span><SheetIcon kind={kind} /></span>{t(`mobileAdd.${kind}`)}
        </button>)}</div>
      <small>{t('mobileAdd.modes')}</small>
      <button className={css.action} type="button" onClick={() => { chooseMode('search') }}>
        <span><SheetIcon kind="search" /></span>
        <span><strong>{t('mobileAdd.search')}</strong><small>{t('mobileAdd.searchHint')}</small></span>
      </button>
      <button className={css.action} type="button" onClick={() => { chooseMode('research') }}>
        <span><SheetIcon kind="research" /></span>
        <span><strong>{t('mobileAdd.research')}</strong><small>{t('mobileAdd.researchHint')}</small></span>
      </button>
      <a className={css.action} href="/hivemind/app/connectors" onClick={close}>
        <span><SheetIcon kind="apps" /></span>
        <span><strong>{t('mobileAdd.connectors')}</strong><small>{t('mobileAdd.connectorsHint')}</small></span>
      </a>
      {controls && <details className={css.options}><summary>{t('mobileAdd.options')}</summary><div>{controls}</div></details>}
      {commands && <button className={css.action} type="button" onClick={commands}>
        <span>/</span><span><strong>{t('mobileAdd.more')}</strong><small>{t('mobileAdd.moreHint')}</small></span>
      </button>}
    </section>
  </div>
}
