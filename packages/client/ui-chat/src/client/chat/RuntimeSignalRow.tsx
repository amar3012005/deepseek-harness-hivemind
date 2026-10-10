import type { RuntimeSignal } from './runtime-signal.ts'
import { IconBellOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ContextInjectionRow.module.css'

/** A passive chat event: never submits, wakes, or changes the composer. */
export function RuntimeSignalRow({ signal, pending }: { signal: RuntimeSignal; pending: boolean }) {
  return <article className={css.messageBubble} data-runtime-signal="" role="status" aria-label="Runtime notification">
    <strong className={css.sender}><span aria-hidden="true" data-runtime-notification-bell=""><IconBellOutline16 /></span> {signal.summary}</strong>
    <p className={css.messageText}>{pending
      ? signal.action === 'notify' ? 'Queued for Runtime’s next turn' : 'Waiting for Runtime'
      : 'Received by Runtime'}</p>
  </article>
}

/** Display only admitted evidence fields, never an actor or raw connector envelope. */
export function RuntimeSignalDetails({ content }: { content: readonly { readonly type: string; readonly text?: string }[] }) {
  let evidence: { title?: unknown; preview?: unknown } | undefined
  try {
    const envelope = JSON.parse(content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')) as { evidence?: typeof evidence }
    evidence = envelope.evidence
  } catch { /* Legacy or malformed evidence has no safe detail presentation. */ }
  return <details className={css.messageDetails}><summary>Update details</summary>
    <div className={css.body}>
      {typeof evidence?.title === 'string' && <p>{evidence.title}</p>}
      {typeof evidence?.preview === 'string' ? <p>{evidence.preview}</p> : <p>No additional details.</p>}
    </div>
  </details>
}
