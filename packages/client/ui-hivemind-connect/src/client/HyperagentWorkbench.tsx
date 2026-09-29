import { useEffect, useState } from 'react'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { isHyperagentPreset } from './HyperagentEmployee.tsx'
import css from './HyperagentEmployee.module.css'

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
      captures.push({ id: data.captureId, url: data.url, title: typeof data.title === 'string' ? data.title : data.url,
        ...(typeof data.status === 'number' ? { status: data.status } : {}), preview: image(data.preview) })
    } else if (type === 'hivemind/research-receipt') {
      for (const row of Array.isArray(data.sources) ? data.sources : []) {
        const source = object(row)
        if (typeof source?.url !== 'string' || seenSources.has(source.url)) continue
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
  openArtifact: (artifact: Artifact) => void
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

/** HyperAgents-only native sidebar body. Preview, artifacts, computer and sources use one session log. */
export function HyperagentWorkbench({ kind, sessionId, useSessions, useEmployeeEvents, loadImage, openArtifact, t }: WorkbenchProps) {
  const preset = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)
  const data = useEmployeeEvents(workbenchSnapshot)
  if (!isHyperagentPreset(preset)) return null
  const lastArtifact = data.artifacts.at(-1)
  const lastCapture = data.captures.at(-1)
  return <div className={css.workbench} data-hivemind-workbench={kind}>
    {kind === 'preview' && (lastArtifact === undefined
      ? <p className={css.workbenchEmpty}>{t('workbench.emptyPreview')}</p>
      : <article><span className={css.workbenchEyebrow}>{lastArtifact.mediaType}</span><h2>{lastArtifact.title}</h2><ReceiptImage attachment={lastArtifact.preview} loadImage={loadImage} /><button type="button" className={css.workbenchOpen} disabled={lastArtifact.file === undefined} onClick={() => { openArtifact(lastArtifact) }}>{t('workbench.open')}</button></article>)}
    {kind === 'artifacts' && (data.artifacts.length === 0
      ? <p className={css.workbenchEmpty}>{t('workbench.emptyArtifacts')}</p>
      : <ul className={css.workbenchList}>{[...data.artifacts].reverse().map(artifact => <li key={artifact.id}><button type="button" disabled={artifact.file === undefined} onClick={() => { openArtifact(artifact) }}>{artifact.title}</button><small>{artifact.mediaType} · {artifact.path.split('/').at(-1)}</small></li>)}</ul>)}
    {kind === 'computer' && (lastCapture === undefined
      ? <p className={css.workbenchEmpty}>{t('workbench.emptyComputer')}</p>
      : <article><span className={css.workbenchEyebrow}>{t('workbench.browserCapture')} {lastCapture.status ?? ''}</span><h2>{lastCapture.title}</h2><ReceiptImage attachment={lastCapture.preview} loadImage={loadImage} /><a href={lastCapture.url} target="_blank" rel="noopener noreferrer">{lastCapture.url}</a></article>)}
    {kind === 'sources' && (data.sources.length === 0
      ? <p className={css.workbenchEmpty}>{t('workbench.emptySources')}</p>
      : <ul className={css.workbenchList}>{data.sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a><small>{source.url}</small></li>)}</ul>)}
  </div>
}
