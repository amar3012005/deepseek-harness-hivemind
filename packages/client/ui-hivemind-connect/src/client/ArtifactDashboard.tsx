import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ReceiptImage, type Artifact } from './HyperagentWorkbench.tsx'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import css from './ArtifactDashboard.module.css'

export interface LibraryArtifact extends Artifact { sessionId: SessionId; roomTitle: string }
export type ArtifactCategory = 'All' | 'Images' | 'Videos' | 'HTML' | 'PDFs' | 'Documents'
export function artifactCategory(artifact: Artifact): ArtifactCategory {
  if (artifact.mediaType.startsWith('image/')) return 'Images'
  if (artifact.mediaType.startsWith('video/')) return 'Videos'
  if (artifact.mediaType === 'application/pdf') return 'PDFs'
  if (artifact.mediaType === 'text/html' || /\.html?$/i.test(artifact.path)) return 'HTML'
  return 'Documents'
}
export interface DashboardSelection { category: ArtifactCategory; selected?: LibraryArtifact | undefined }
interface Props {
  selection: DashboardSelection
  load: (signal: AbortSignal, progress: (result: { artifacts: LibraryArtifact[]; incomplete: boolean }) => void) =>
  Promise<{ artifacts: LibraryArtifact[]; incomplete: boolean }>
  loadImage: (sessionId: SessionId, ref: ImageAttachmentRef) => Promise<string>
  renderArtifact: (artifact: LibraryArtifact) => ReactNode
  page?: boolean
  hostSeat?: boolean
  expand: () => void
  collapse: () => void
}
const categories: ArtifactCategory[] = ['All', 'Images', 'Videos', 'HTML', 'PDFs', 'Documents']

/** Presentation over native saved receipts; never starts work or generates previews. */
export function ArtifactDashboard({ load, loadImage, renderArtifact, page = false, hostSeat = false, expand, collapse, selection }: Props) {
  const [seat, setSeat] = useState<HTMLElement | null>(() => hostSeat ? document.querySelector('[data-hivemind-artifacts-seat]') : null)
  useEffect(() => {
    if (!hostSeat) return
    const update = () => { setSeat(document.querySelector('[data-hivemind-artifacts-seat]')) }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [hostSeat])
  const [open, setOpen] = useState(page)
  const [fullscreen, setFullscreen] = useState(false)
  const [selected, setSelected] = useState<LibraryArtifact | undefined>(selection.selected)
  const [category, setCategory] = useState<ArtifactCategory>(selection.category)
  const [artifacts, setArtifacts] = useState<LibraryArtifact[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [incomplete, setIncomplete] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const close = () => { setOpen(false); setFullscreen(false); setSelected(undefined); if (page) collapse(); trigger.current?.focus() }
  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    setLoading(true)
    setError(undefined)
    setArtifacts([])
    setIncomplete(false)
    const update = (result: { artifacts: LibraryArtifact[]; incomplete: boolean }) => {
      if (!abort.signal.aborted) { setArtifacts(result.artifacts); setIncomplete(result.incomplete) }
    }
    void loadRef.current(abort.signal, update).then((result) => {
      if (!abort.signal.aborted) { setArtifacts(result.artifacts); setIncomplete(result.incomplete) }
    }, (reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Artifacts could not be loaded.') })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { abort.abort() }
  }, [open, refresh])
  useEffect(() => {
    if (!open || page) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.focus()
    return () => { document.body.style.overflow = previousOverflow }
  }, [open, page])
  useEffect(() => { selection.category = category; selection.selected = selected }, [selection, category, selected])
  const visible = artifacts.filter(item => category === 'All' || artifactCategory(item) === category)
  const contents = open && <div className={css.backdrop} data-page={page || undefined}
    onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <div ref={dialog} className={css.dashboard} role={page ? 'region' : 'dialog'} aria-modal={page ? undefined : true} aria-label="Artifacts" tabIndex={-1} data-artifact-dashboard={page ? 'page' : 'popup'} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); if (fullscreen) setFullscreen(false); else if (selected) setSelected(undefined); else close() }
      if (!page && event.key === 'Tab') {
        const buttons = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],iframe,video[controls],[tabindex="0"]')
        const first = buttons?.[0]; const last = buttons?.[buttons.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          event.preventDefault(); last?.focus()
        }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <header className={css.header}><div><span className={css.eyebrow}>YOUR TEAM’S WORK</span>
        <h1>Artifacts</h1><p>Saved work from Runtime and your agents.</p></div>
      <div className={css.actions}>
        <button type="button" aria-label={page ? 'Back to conversation' : 'Expand artifact dashboard'} title={page ? 'Back' : 'Expand'} onClick={() => { if (page) collapse(); else { setOpen(false); expand() } }}>{page ? '↙' : '↗'}</button>
        <button type="button" aria-label="Close artifacts" onClick={close}>×</button>
      </div></header>
      {!selected && <nav className={css.filters} aria-label="Artifact types">{categories.map(type => <button type="button" key={type} aria-pressed={category === type} onClick={() => { setCategory(type) }}>{type}</button>)}<button className={css.refresh} type="button" disabled={loading} onClick={() => { setRefresh(refresh + 1) }}>Refresh</button></nav>}
      <div className={css.content}>
        {selected ? <div className={css.viewer} data-fullscreen={fullscreen || undefined}>
          <div className={css.viewerBar}><button type="button" onClick={() => { setSelected(undefined); setFullscreen(false) }}>← All artifacts</button><strong>{selected.title}</strong><button type="button" aria-label={fullscreen ? 'Fit artifact to dashboard' : 'Expand artifact fullscreen'} onClick={() => { setFullscreen(!fullscreen) }}>{fullscreen ? 'Fit to dashboard' : 'Fullscreen'}</button></div>
          <div className={css.viewerContent}>{renderArtifact(selected)}</div>
        </div> : loading && artifacts.length === 0 ? <div className={css.empty} role="status">Loading saved artifacts…</div> : error ? <div className={css.empty} role="alert"><p>{error}</p><button type="button" onClick={() => { setRefresh(refresh + 1) }}>Try again</button></div> : <>
          {loading && <p className={css.notice} role="status">Loading more saved artifacts…</p>}
          {incomplete && <p className={css.notice} role="status">Some older files or rooms could not be loaded. Open the agent’s room to find older work.</p>}
          {visible.length === 0 ? <div className={css.empty}><strong>{artifacts.length === 0 ? 'Your work will appear here' : `No ${category.toLowerCase()} yet`}</strong><p>Saved deliverables appear here when an agent creates or shares them.</p></div> : <div className={css.grid}>{visible.map(item => <button key={`${item.sessionId}:${item.id}`} type="button" className={css.tile} onClick={() => { setSelected(item) }} aria-label={`Open ${item.title}, ${artifactCategory(item)}, from ${item.roomTitle}`}>
            <div className={css.cover}>{item.preview ? <ReceiptImage attachment={item.preview} loadImage={ref => loadImage(item.sessionId, ref)} /> : <span className={css.format}>{artifactCategory(item) === 'Documents' ? item.mediaType.split('/').at(-1)?.toUpperCase() : artifactCategory(item)}</span>}</div>
            <div className={css.caption}><strong>{item.title}</strong>
              <span>{item.roomTitle}</span><small>{artifactCategory(item)}</small></div>
          </button>)}</div>}
        </>}
      </div>
    </div>
  </div>
  if (hostSeat && !seat) return null
  const triggerButton = !page && <button ref={trigger} type="button" className={css.trigger} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true) }}>▧ <span>Artifacts</span></button>
  return <>
    {seat ? createPortal(triggerButton, seat) : triggerButton}
    {page ? contents : contents && createPortal(contents, document.body)}
  </>
}

/** Authenticated saved raster/video bytes; no remote media URLs or HTML execution. */
export function ArtifactMedia({ artifact, loadBlob }: { artifact: LibraryArtifact; loadBlob: (file: NonNullable<Artifact['file']>) => Promise<Blob> }) {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  const loader = useRef(loadBlob)
  loader.current = loadBlob
  useEffect(() => {
    let active = true
    let created: string | undefined
    setUrl(undefined); setFailed(false)
    if (artifact.file) void loader.current(artifact.file).then((blob) => {
      if (!active) return
      created = URL.createObjectURL(blob); setUrl(created)
    }, () => { if (active) setFailed(true) })
    return () => { active = false; if (created) URL.revokeObjectURL(created) }
  }, [artifact.sessionId, artifact.id])
  if (failed) return <p role="alert">This artifact could not be loaded.</p>
  if (!url) return <p role="status">Loading artifact…</p>
  return artifact.mediaType.startsWith('video/') ? <video controls src={url} aria-label={artifact.title} /> : <img src={url} alt={artifact.title} />
}
