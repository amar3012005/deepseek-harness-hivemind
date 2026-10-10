import type { RuntimeSignal } from './runtime-signal.ts'
import { runtimeSignalEvidence } from './runtime-signal.ts'
import { useState } from 'react'
import { IconBellOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './RuntimeSignalRow.module.css'

function AppLogo({ signal }: { signal: RuntimeSignal }) {
  const [failedUrl, setFailedUrl] = useState<string>()
  return <span className={css.logo} aria-hidden="true" data-runtime-signal-logo="">
    {signal.logoUrl !== undefined && failedUrl !== signal.logoUrl
      ? <img src={signal.logoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => { setFailedUrl(signal.logoUrl) }} />
      : <span>{signal.appName.slice(0, 1)}</span>}
  </span>
}

/** A passive chat event: never submits, wakes, or changes the composer. */
export function RuntimeSignalRow({ signal, pending }: { signal: RuntimeSignal; pending: boolean }) {
  const delivery = pending
    ? signal.action === 'notify' ? 'Queued for Runtime’s next turn' : 'Waiting for Runtime'
    : 'Received by Runtime'
  return <article className={css.banner} data-runtime-signal="" data-action={signal.action} role="status" aria-label={signal.action === 'wake' ? 'Runtime wake request' : 'Runtime notification'}>
    <span className={css.bell} aria-hidden="true" data-runtime-notification-bell=""><IconBellOutline16 /></span>
    <AppLogo signal={signal} />
    <strong className={css.appName}>{signal.appName}</strong>
    <span className={css.context}>{signal.summary}</span>
    <span className={css.accessibleStatus}><span>{signal.action === 'wake' ? 'Wake requested. ' : 'Notification. '}</span><span>{delivery}</span></span>
  </article>
}

/** Display only admitted evidence fields, never an actor or raw connector envelope. */
export function RuntimeSignalDetails({ content }: { content: readonly { readonly type: string; readonly text?: string }[] }) {
  const evidence = runtimeSignalEvidence(content)
  return <details className={css.details}><summary>Update details</summary>
    <div className={css.detailsBody}>
      {evidence.title !== undefined && <p>{evidence.title}</p>}
      {evidence.preview !== undefined ? <p>{evidence.preview}</p> : <p>No additional details.</p>}
    </div>
  </details>
}
