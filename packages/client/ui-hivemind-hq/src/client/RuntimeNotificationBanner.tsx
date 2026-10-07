import { useMemo, useSyncExternalStore } from 'react'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { runtimeNotifications, type RuntimeNotification } from './runtime-notification.ts'
import css from './RuntimeNotificationBanner.module.css'
const copy: Record<RuntimeNotification['status'], { title: string; detail: string; mark: string }> = {
  sending: { title: 'Sending email…', detail: 'Waiting for the email service receipt.', mark: '…' },
  sent: { title: 'Email sent', detail: 'Accepted by the email service. Reading is not confirmed.', mark: '✓' },
  delivered: { title: 'Delivery confirmed', detail: 'Accepted by the recipient’s mail server. Reading is not confirmed.', mark: '✓' },
  failed: { title: 'Email not sent', detail: 'The email service did not accept this notification.', mark: '!' },
  'delivery-failed': { title: 'Email delivery failed', detail: 'The delivery receipt reports a failure.', mark: '!' },
  unknown: { title: 'Delivery unconfirmed', detail: 'No confirmed send receipt is saved. Runtime must reconcile before retrying.', mark: '?' },
}
/** A persistent, read-only banner, placed outside the collapsible tool trace. */
export interface RuntimeNotificationBannerProps {
  turn: number
  events: { subscribe(listener: () => void): () => void; getSnapshot(): SessionEventWindow }
}
export function RuntimeNotificationBanner({ turn, events }: RuntimeNotificationBannerProps) {
  const log = useSyncExternalStore(listener => events.subscribe(listener), () => events.getSnapshot())
  const cards = useMemo(() => runtimeNotifications(log).filter(card => card.turn === turn), [log, turn])
  return cards.length === 0 ? null : <section aria-label="Runtime email notifications" className={css.list}>
    {cards.map((card) => {
      const state = copy[card.status]
      const validTime = Number.isFinite(card.time) && Number.isFinite(new Date(card.time).getTime())
      return <aside key={card.key} data-runtime-notification-banner data-email-status={card.status} className={css.banner}>
        <span aria-hidden="true" className={css.mark}>{state.mark}</span>
        <div className={css.copy}><div className={css.heading}><strong>{state.title}</strong>
          {validTime && <time dateTime={new Date(card.time).toISOString()}>{new Date(card.time).toLocaleString(undefined,
            { dateStyle: 'medium', timeStyle: 'short' })}</time>}</div>
        <p className={css.subject}>{card.subject}</p><p className={css.detail}>{state.detail}</p>
        {card.kind === 'approval' && <p className={css.detail}>Approval still requires your explicit decision in this chat.</p>}
        </div>
      </aside>
    })}
  </section>
}
