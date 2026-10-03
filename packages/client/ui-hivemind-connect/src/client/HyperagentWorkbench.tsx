import { useEffect, useRef, useState } from 'react'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './HyperagentEmployee.module.css'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    'hivemind-workbench-preview': { artifactId: string }
  }
}
const lastViewedArtifacts = new Map<string, string>()

type Kind = 'preview' | 'artifacts' | 'computer' | 'sources'

interface Artifact {
  id: string
  title: string
  mediaType: string
  path: string
  file: FileAttachmentRef | undefined
  preview: ImageAttachmentRef | undefined
}
interface Capture { id: string; title: string; url: string; status?: number; preview: ImageAttachmentRef | undefined }
interface Source { url: string; title: string }
interface Workbench { artifacts: Artifact[]; captures: Capture[]; sources: Source[] }

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function image(value: unknown): ImageAttachmentRef | undefined {
  const ref = object(value)
  return typeof ref?.attachmentId === 'string' && typeof ref.mediaType === 'string' ? ref as unknown as ImageAttachmentRef : undefined
}

function file(value: unknown): FileAttachmentRef | undefined {
  const ref = object(value)
  return typeof ref?.attachmentId === 'string' && typeof ref.name === 'string' && typeof ref.bytes === 'number'
    ? ref as unknown as FileAttachmentRef : undefined
}

/** Only terminal, durable receipts populate preview. No provider payloads or speculative outputs. */
export function workbenchSnapshot(window: SessionEventWindow): Workbench {
  const artifacts: Artifact[] = []
  const captures: Capture[] = []
  const sources: Source[] = []
  const seenSources = new Set<string>()
  for (const entry of window.entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    const data = object(event.data)
    if (data === undefined) continue
    const type = String(event.type)
    if (type === 'hivemind/artifact-created' || type === 'hivemind/generation-created') {
      if (typeof data.artifactId !== 'string' || typeof data.path !== 'string') continue
      artifacts.push({ id: data.artifactId, title: typeof data.title === 'string' ? data.title : 'Artifact', path: data.path,
        mediaType: typeof data.mediaType === 'string' ? data.mediaType : 'application/octet-stream',
        file: file(data.pdf ?? data.file), preview: image(data.preview) })
    } else if (type === 'hivemind/browser-capture') {
      if (typeof data.captureId !== 'string' || typeof data.url !== 'string') continue
      if (image(data.preview)) artifacts.push({ id: data.captureId, title: typeof data.title === 'string' ? data.title : 'Website screenshot', path: typeof object(data.file)?.name === 'string' ? String(object(data.file)?.name) : 'Website screenshot.png', mediaType: 'image/png', file: file(data.file), preview: image(data.preview) })
      captures.push({ id: data.captureId, url: data.url, title: typeof data.title === 'string' ? data.title : data.url,
        ...(typeof data.status === 'number' ? { status: data.status } : {}), preview: image(data.preview) })
    } else if (type === 'hivemind/research-receipt') {
      for (const row of Array.isArray(data.sources) ? data.sources : []) {
        const source = object(row)
        if (typeof source?.url !== 'string' || !/^https?:\/\//i.test(source.url) || seenSources.has(source.url)) continue
        seenSources.add(source.url)
        sources.push({ url: source.url, title: typeof source.title === 'string' ? source.title : source.url })
      }
    }
  }
  return { artifacts, captures, sources }
}

type WorkbenchProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'hivemind-connect'> & {
  kind: Kind
  useEmployeeEvents: SnapshotSelectorHook<SessionEventWindow>
  loadImage: (ref: ImageAttachmentRef) => Promise<string>
  loadPdf: (ref: FileAttachmentRef) => Promise<Blob>
  openArtifact: (artifact: Artifact, disposition?: 'open' | 'download') => void
  openWorkbench: (kind: Kind) => void
  selectArtifact: (id: string) => void
}

function ReceiptImage({ attachment, loadImage }: { attachment: ImageAttachmentRef | undefined; loadImage: WorkbenchProps['loadImage'] }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    let active = true
    setUrl(undefined)
    if (attachment !== undefined) void loadImage(attachment).then((value) => { if (active) setUrl(value) }, () => {})
    return () => { active = false }
  }, [attachment?.attachmentId, loadImage])
  return url === undefined ? null : <img className={css.workbenchImage} src={url} alt="Generated preview" />
}

function PdfReceipt({ artifact, loadPdf, loadImage, t }: { artifact: Artifact; loadPdf: WorkbenchProps['loadPdf']; loadImage: WorkbenchProps['loadImage']; t: WorkbenchProps['t'] }) {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  const loadPdfRef = useRef(loadPdf)
  loadPdfRef.current = loadPdf
  useEffect(() => {
    let active = true
    let createdUrl: string | undefined
    setUrl(undefined)
    setFailed(false)
    if (artifact.file !== undefined) {
      void loadPdfRef.current(artifact.file).then((blob) => {
        if (!active) return
        createdUrl = URL.createObjectURL(blob)
        setUrl(createdUrl)
      }, () => { if (active) setFailed(true) })
    }
    return () => {
      active = false
      if (createdUrl !== undefined) URL.revokeObjectURL(createdUrl)
    }
  }, [artifact.file?.attachmentId])
  return url === undefined
    ? <>{failed && <p className={css.workbenchPath} role="status">{t('workbench.pdfUnavailable')}</p>}<ReceiptImage attachment={artifact.preview} loadImage={loadImage} /></>
    : <><a className={css.workbenchOpen} href={url} download={artifact.file?.name}>{t('workbench.downloadPdf')}</a><iframe className={css.workbenchPdf} src={url} title={artifact.title} /></>
}

/** Shared native workbench backed by the current session log. */
export function HyperagentWorkbench({
  kind, sessionId, useTabInfo, useEmployeeEvents, loadImage, loadPdf, openArtifact, selectArtifact, t,
}: WorkbenchProps) {
  const data = useEmployeeEvents(workbenchSnapshot)
  const info = useTabInfo()
  const requested = (info.tab.navigation.params as { artifactId?: string } | undefined)?.artifactId
  const [view, setView] = useState<'stack' | 'grid'>('stack')
  const [filter, setFilter] = useState('all')
  const [latestViewed, setLatestViewed] = useState(lastViewedArtifacts.get(sessionId))
  const choose = (artifact: Artifact) => {
    lastViewedArtifacts.set(sessionId, artifact.id)
    setLatestViewed(artifact.id)
    selectArtifact(artifact.id)
  }
  const [selectedSource, setSelectedSource] = useState<Source | null>(null)
  useEffect(() => { setSelectedSource(null) }, [sessionId])
  const lastArtifact = data.artifacts.find(artifact => artifact.id === requested) ?? data.artifacts.at(-1)
  const lastCapture = data.captures.at(-1)
  return <div className={css.workbench} data-hivemind-workbench={kind}>
    {kind === 'preview' && (lastArtifact === undefined
      ? <p className={css.workbenchEmpty}>{t('workbench.emptyPreview')}</p>
      : <article><span className={css.workbenchEyebrow}>{lastArtifact.mediaType}</span><h2>{lastArtifact.title}</h2>{lastArtifact.mediaType === 'application/pdf' && lastArtifact.file !== undefined
        ? <PdfReceipt artifact={lastArtifact} loadPdf={loadPdf} loadImage={loadImage} t={t} />
        : <><div className={css.workbenchActions}><button type="button" className={css.workbenchOpen} disabled={lastArtifact.file === undefined} onClick={() => { openArtifact(lastArtifact, 'download') }}>{t('workbench.download')}</button></div><ReceiptImage attachment={lastArtifact.preview} loadImage={loadImage} /></>}</article>)}
    {kind === 'artifacts' && <>
      <header className={css.galleryHeader}><strong>{t('workbench.artifacts')}</strong><select aria-label={t('workbench.filter')} value={filter} onChange={(event) => { setFilter(event.target.value) }}><option value="all">{t('workbench.all')}</option>{[...new Set(data.artifacts.map(artifact => artifact.mediaType))].map(type => <option key={type} value={type}>{type}</option>)}</select><button type="button" onClick={() => { setView(view === 'stack' ? 'grid' : 'stack') }}>{t(view === 'stack' ? 'workbench.grid' : 'workbench.stack')}</button></header>
      {data.artifacts.length === 0 ? <p className={css.workbenchEmpty}>{t('workbench.emptyArtifacts')}</p> : <div className={css.artifactGallery} data-view={view}>{[...data.artifacts].reverse().filter(artifact => filter === 'all' || artifact.mediaType === filter).map((artifact, index) => <button key={artifact.id} type="button" className={css.artifactCard} style={{ zIndex: data.artifacts.length - index }} onClick={() => { choose(artifact) }} aria-label={`${t('workbench.open')}: ${artifact.title}`}>
        <div className={css.artifactCover}>{artifact.preview ? <ReceiptImage attachment={artifact.preview} loadImage={loadImage} /> : <span className={css.artifactFormat}>{artifact.mediaType === 'application/pdf' ? 'PDF' : /\.pptx?$/i.test(artifact.path) ? 'PPTX' : /\.docx?$/i.test(artifact.path) ? 'DOC' : artifact.mediaType === 'text/markdown' ? 'MD' : artifact.mediaType.split('/').at(-1)?.toUpperCase()}</span>}{latestViewed === artifact.id && <span className={css.lastViewed}>{t('workbench.lastViewed')}</span>}</div><span className={css.artifactCaption}><strong>{artifact.title}</strong><small>{artifact.path.split('/').at(-1)}</small></span>
      </button>)}</div>}
    </>}
    {kind === 'computer' && (lastCapture === undefined
      ? <p className={css.workbenchEmpty}>{t('workbench.emptyComputer')}</p>
      : <article><span className={css.workbenchEyebrow}>{t('workbench.browserCapture')} {lastCapture.status ?? ''}</span><h2>{lastCapture.title}</h2><ReceiptImage attachment={lastCapture.preview} loadImage={loadImage} /><a href={lastCapture.url} target="_blank" rel="noopener noreferrer">{lastCapture.url}</a></article>)}
    {kind === 'sources' && (data.sources.length === 0
      ? <p className={css.workbenchEmpty}>{t('workbench.emptySources')}</p>
      : <><ul className={css.workbenchList}>{data.sources.map(source => <li key={source.url}><button type="button" onClick={() => { setSelectedSource(source) }}>{source.title}</button><small>{source.url}</small></li>)}</ul>{selectedSource !== null && <article><h2>{selectedSource.title}</h2><a href={selectedSource.url} target="_blank" rel="noopener noreferrer">{selectedSource.url}</a><iframe className={css.workbenchPdf} title={selectedSource.title} src={selectedSource.url} sandbox="allow-scripts" referrerPolicy="no-referrer" /></article>}</>)}
  </div>
}
