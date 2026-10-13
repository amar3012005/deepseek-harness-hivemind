import { Fragment, memo, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions, MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { AssistantBlock } from '../contract/snapshot.ts'
import { markdownLabels } from '../markdown-labels.ts'
import { ReasoningRow } from './ReasoningRow.tsx'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './AssistantMarkdown.module.css'

const HIVE_FOLLOW_UP_MARKER = /<!--\s*hivemind-follow-ups:\s*\[[\s\S]*?\]\s*-->/giu
const HIVE_PARTIAL_FOLLOW_UP_MARKER = /<!--\s*hivemind-follow-ups:[\s\S]*$/iu

/** Hide HIVE control metadata from prose without changing the durable message. */
export function visibleAssistantText(text: string): string {
  if (document.documentElement.dataset.dshMode !== 'hivemind-chat') return text
  return text.replace(HIVE_FOLLOW_UP_MARKER, '').replace(HIVE_PARTIAL_FOLLOW_UP_MARKER, '').trimEnd()
}

/**
 * Map one authored media destination to the same-origin workspace-file URL.
 * @param protocol - `window.location.protocol` at render time.
 * @param origin - `window.location.origin` at render time.
 * @param value - The authored markdown destination, exactly as written.
 * @returns The API URL for an absolute POSIX path on an HTTP(S) page, or
 * undefined when the destination cannot be a Host-served local file
 * (non-HTTP transport such as Electron `file://`, protocol-relative or
 * relative destinations).
 */
export function localPathMediaUrl(protocol: string, origin: string, value: string): string | undefined {
  if (protocol !== 'http:' && protocol !== 'https:') return undefined
  if (value.length === 0 || !value.startsWith('/') || value.startsWith('//')) return undefined
  return `${origin}/api/file?path=${encodeURIComponent(value)}`
}

export interface AssistantMarkdownProps {
  blocks: readonly AssistantBlock[]
  streaming: boolean
  /** Authoritative turn closing answer retains the native full-width prose presentation. */
  finalAnswer?: boolean | undefined
  /** Frozen partial of an aborted turn: rendered with a stopped marker. */
  interrupted?: boolean | undefined
  /** Render consecutive image blocks through the attachment slot. */
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  /** Hide reasoning that belongs to the Turn-level process disclosure. */
  reasoningHidden?: boolean | undefined
  /** Reveal the owning Turn-level process disclosure. */
  revealProcess?: (() => void) | undefined
  /** Resolved prose file mentions for this Assistant's closing turn. */
  mentions?: MarkdownFileMentions | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

function AssistantImageCard({ src, destination, alt, open, label, openLabel }: {
  src: string
  destination: string
  alt: string
  open: () => void
  label: string
  openLabel: string
}) {
  const [failed, setFailed] = useState(false)
  const name = destination.split(/[?#]/u)[0]?.split('/').pop() || alt || label
  if (failed) return <span>{alt || name}</span>
  return <span className={css.artifactImageCard} data-artifact-card>
    <button type="button" className={css.artifactImageThumbnail} onClick={open} aria-label={`${openLabel}: ${name}`}>
      <img src={src} alt={alt || name} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => { setFailed(true) }} />
    </button>
    <span className={css.artifactImageFooter}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m3 17 5-5 4 4 4-6 5 7" /></svg>
      <span><strong>{name}</strong><small>{label}</small></span>
      <button type="button" onClick={open}>{openLabel}</button>
    </span>
  </span>
}

/** Reasoning block as the Think variant summary row (figma 39:28304). */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  blocks, streaming, interrupted, renderMessageImages,
  reasoningHidden = false, revealProcess, mentions, t, finalAnswer = false,
}: AssistantMarkdownProps) {
  // Brain has a deliberately small public surface: activity belongs to the
  // composer orb until there is answer prose.  Provider selection prevents
  // reasoning upstream, while this guard keeps an unexpected provider chunk
  // from becoming customer-facing process disclosure.
  const hideBrainReasoning = document.documentElement.dataset.dshMode === 'hivemind-chat'
  // Stable per locale revision (t identity changes on switch): a fresh object
  // per render would rebuild MarkdownText's component table every chunk.
  const labels = useMemo(() => markdownLabels(t), [t])
  // Local media paths in the closing prose rewrite to the same-origin file
  // API (policy re-validation lives host-side). The vocabulary identity is
  // stable per page load because MarkdownText memoizes on it.
  const pathImages = useMemo<MarkdownPathImages>(() => {
    const { protocol, origin } = window.location
    return {
      resolve: value => localPathMediaUrl(protocol, origin, value),
      renderImage: props => <AssistantImageCard {...props} open={() => {
        const knownFile = mentions?.resolve(props.destination)
        if (knownFile !== undefined) knownFile.open()
        else window.open(props.src, '_blank', 'noopener,noreferrer')
      }} label={t('artifact.image')} openLabel={t('artifact.open')} />,
    }
  }, [mentions, t])
  const last = blocks.length - 1
  // Tool-call heads render as tool rows in the chat view's grouping pass, so
  // a node that is only those heads (or empty) would paint an empty root
  // between tool groups — skip the shell unless something visible remains.
  const hasVisible = interrupted === true
    || blocks.some(block => block.kind !== 'tool-call' && (!hideBrainReasoning || block.kind !== 'reasoning'))
  if (!hasVisible) return null
  const rendered: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block === undefined) continue
    switch (block.kind) {
      case 'text':
        {
          const text = visibleAssistantText(block.text)
          if (text === '' && !streaming) break
          rendered.push(
            <MarkdownText
              key={i}
              text={text}
              streaming={streaming}
              labels={labels}
              fileMentions={mentions}
              pathImages={pathImages}
            />,
          )
        }
        break
      case 'reasoning':
        if (!hideBrainReasoning) {
          rendered.push(
            <ProcessReasoning
              key={i}
              hidden={reasoningHidden}
              reveal={revealProcess}
            >
              <ReasoningRow text={block.text} running={streaming && i === last} t={t} />
            </ProcessReasoning>,
          )
        }
        break
      case 'image': {
        // Consecutive image blocks share one gallery so several images tile
        // into rows instead of each opening a one-image group of its own.
        // Keyed by the group's FIRST block index: a streaming append that
        // extends the group then only grows `images` instead of remounting
        // the gallery under a shifted key.
        const start = i
        const group = [block]
        while (i + 1 < blocks.length) {
          const next = blocks[i + 1]
          if (next === undefined || next.kind !== 'image') break
          group.push(next)
          i += 1
        }
        rendered.push(
          <Fragment key={start}>
            {renderMessageImages({
              images: group.map(({ attachment }) => ({ attachment })),
              align: 'start',
              artifactCard: true,
            })}
          </Fragment>,
        )
        break
      }
      // Grouped into tool rows by ChatView; hasVisible above skips an empty shell.
      case 'tool-call':
        break
      default:
        rendered.push(
          <JsonBlock
            key={i}
            label={t('message.unknownBlock')}
            payload={block.block}
            truncatedLabel={total => t('json.truncated', { total })}
          />,
        )
    }
  }
  const readableReply = !hideBrainReasoning && /^\/hivemind\/app\/(?:overview|employee\/harness)(?:\/|$)/u.test(window.location.pathname)
    && (!finalAnswer || /^\/hivemind\/app\/employee\/harness(?:\/|$)/u.test(window.location.pathname))
    && blocks.some(block => block.kind === 'text' && visibleAssistantText(block.text).trim() !== '')
  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      <div className={css.body} data-assistant-text={blocks.some(block => block.kind === 'text' && visibleAssistantText(block.text).trim() !== '') || undefined} data-readable-reply={readableReply || undefined}>
        {rendered}
        {interrupted && <span className={css.stopped}>{t('message.stopped')}</span>}
      </div>
    </div>
  )
})

function ProcessReasoning({ hidden, reveal, children }: {
  hidden: boolean
  reveal?: (() => void) | undefined
  children: ReactNode
}) {
  const ref = useSearchableHidden(hidden, reveal ?? NOOP)
  return <div ref={ref} data-turn-process-inline={hidden || undefined}>{children}</div>
}

const NOOP = (): void => {}
