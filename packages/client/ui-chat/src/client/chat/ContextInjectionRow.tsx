import type { ReactNode } from 'react'
import { useState } from 'react'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { DisclosureRow, FileTypeIcon, fileSizeText, IconContextInjectionOutline16, ReferenceIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContextMessageNode } from '../contract/snapshot.ts'
import { contextBody } from './ContextBody.tsx'
import css from './ContextInjectionRow.module.css'
import messageCss from './MessageItem.module.css'

/** Props for the logged non-user message presentation. */
export interface ContextInjectionRowProps {
  content: ContextMessageNode['content']
  source: ContextMessageNode['source']
  /** Role and producer name projected from the durable source. */
  provenance: ContextMessageNode['provenance']
  /** Producer-declared information form; null renders the opaque body. */
  form: ContextMessageNode['form']
  /** The owning view's locale seat, passed down as a plain prop. */
  avatar?: (identity: { employeeId?: string; name?: string }) => ReactNode
  openArtifact?: (artifactId: string) => void
  t: ChatViewSlotProps['t']
}

/**
 * Render logged context with the Tool calls disclosure chrome from Figma.
 *
 * The header names the role the context plays and, beside it, the producer the
 * durable source identifies, so a reader can tell an injected skill catalog
 * from a workspace instruction file or a recalled session without expanding.
 * The expanded body follows the producer-declared form; an absent or unknown
 * form renders the opaque body.
 * @param props - Durable content, its projected producer role/name and form, and the locale seat.
 * @returns A collapsed context row with a bounded, form-specific body.
 */
export function ContextInjectionRow({ content, source, provenance, form, openArtifact, avatar, t }: ContextInjectionRowProps) {
  const [open, setOpen] = useState(false)
  // Presentation only: durable prompt/context events remain available for future inspection.
  const agentMessage = typeof source === 'object' && source !== null && 'kind' in source && source.kind === 'hivemind-agent-message'
  if (!agentMessage && typeof document !== 'undefined' && document.documentElement.dataset.dshMode === 'hivemind-chat') return null
  const producerLabel = agentMessage ? 'Team' : provenance.label
  // Resolved rather than declared: a form whose fields are unreadable renders
  // the opaque body, and the marker must say what the row actually shows.
  const { rendered, summary, body } = contextBody(form, { content, source, t })

  // Team delivery stores the complete message envelope, not the truncated notice summary.
  if (agentMessage) {
    const text = content.filter(block => block.type === 'text').map(block => block.text).join('')
    let message: { senderName?: unknown; senderEmployee?: unknown; text?: unknown; artifacts?: unknown } | undefined
    try { message = JSON.parse(text) as typeof message } catch { /* Older records retain the existing disclosure. */ }
    if (typeof message?.text === 'string' && typeof message.senderName === 'string') {
      return <div className={css.messageRow}>{avatar?.({ ...(typeof message.senderEmployee === 'string' ? { employeeId: message.senderEmployee } : {}), name: message.senderName })}<article className={css.messageBubble} aria-label={`Message from ${message.senderName}`}>
        <strong className={css.sender}>{message.senderName}</strong>
        <p className={css.messageText}>{message.text.startsWith(`${message.senderName}:`) ? message.text.slice(message.senderName.length + 1).trimStart() : message.text}</p>
        <div className={messageCss.attachmentRow} data-team-artifacts>
          {content.filter(block => block.type === 'file').map((block, index) => {
            const artifact = Array.isArray(message.artifacts) ? message.artifacts.find((item: unknown) => {
              if (typeof item !== 'object' || item === null) return false
              const value = item as { file?: { attachmentId?: unknown } }
              return value.file?.attachmentId === block.attachment.attachmentId
            }) as { artifactId?: unknown } | undefined : undefined
            const id = typeof artifact?.artifactId === 'string' ? artifact.artifactId : undefined
            return <button key={`${block.attachment.attachmentId}:${index}`} type="button" className={messageCss.fileCard}
              disabled={id === undefined || openArtifact === undefined}
              aria-label={`Open ${block.attachment.name} in Preview`}
              onClick={() => { if (id !== undefined) openArtifact?.(id) }}>
              <FileTypeIcon path={block.attachment.name} className={messageCss.fileIcon} />
              <span className={messageCss.fileContent}><span className={messageCss.fileName}>{block.attachment.name}</span>
                <span className={messageCss.fileMeta}>{fileSizeText(block.attachment.bytes)}</span></span>
            </button>
          })}
        </div>
        <details className={css.messageDetails}>
          <summary>Work details</summary>
          <div className={css.body} data-context-injection-body data-context-form={rendered ?? undefined}>{body}</div>
        </details>
      </article></div>
    }
  }

  return (
    <DisclosureRow
      className={css.root}
      icon={provenance.role === 'recall'
        ? <span data-context-recall-icon><ReferenceIcon kind="session" /></span>
        : <IconContextInjectionOutline16 size={14} />}
      chevronClassName={css.chevron}
      title={agentMessage ? (form === 'notice' ? 'Agent update' : 'Agent message') : t(provenance.role === 'recall' ? 'message.contextRecall' : 'message.contextInjection')}
      collapsedContent={producerLabel === null ? undefined : (
        /* ToolRow's separator shape: an aria-hidden dot, so the accessible name
           stays the two readable parts and the two disclosure rows expose one
           name shape. A source that names no producer drops the dot with it. */
        <>
          <span className={css.sep} aria-hidden />
          <span className={css.source} data-context-source>{typeof document !== 'undefined' && document.documentElement.dataset.dshMode === 'hivemind-chat'
            ? producerLabel.replace(/^dsh-hivemind-runtime\/turn$/u, 'HIVEMIND context').replace(/DeepSeek Harness|deepseek-harness|\bDSH\b|\bdsh-/gu, 'HIVEMIND ') : producerLabel}</span>
          {summary !== null && (
            <>
              <span className={css.sep} aria-hidden />
              <span className={css.summary} data-context-summary>{summary}</span>
            </>
          )}
        </>
      )}
      keepContentWhenOpen
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <div className={css.body} data-context-injection-body data-context-form={rendered ?? undefined}>
        {body}
      </div>
    </DisclosureRow>
  )
}
