import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemorySaveDestination, PendingQuestion, QuestionComposerProps } from './contract/slots.ts'
import css from './PlanReviewPanel.module.css'

export type DestinationApprovalPanelProps =
  { pending: PendingQuestion; destination: MemorySaveDestination } & Pick<QuestionComposerProps, 't'>

export function DestinationApprovalPanel({ pending, destination, t }: DestinationApprovalPanelProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const settle = (send: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void send().catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  return (
    <div className={css.frame} data-memory-save-destination-key={pending.key}>
      <section className={css.card} aria-label={destination.question}>
        <div className={css.strip}>
          <span className={css.dot} aria-hidden="true" />
          <span className={css.eyebrow}>{t('save.header')}</span>
        </div>
        <div className={css.body}>
          <p className={css.headline}>{destination.question}</p>
          {destination.detail ? <p>{destination.detail}</p> : null}
          <div className={css.choices} role="radiogroup" aria-label={t('save.header')}>
            {destination.options.map(option => (
              <Button
                key={option.label}
                variant={selected === option.label ? 'primary' : 'outline'} className={css.action}
                disabled={busy}
                title={option.description}
                onClick={() => { setSelected(option.label) }}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
        <div className={css.footer}>
          <div className={css.actions}>
            <Button
              variant="primary" className={css.action}
              disabled={busy || selected === null}
              onClick={() => {
                if (selected === null) return
                settle(() => pending.answer({ answers: [{ id: destination.id, selected: [selected] }] }))
              }}
            >
              {t('save.submit')}
            </Button>
            <Button variant="outline" className={css.action} disabled={busy} onClick={() => { settle(() => pending.cancel()) }}>
              {t('save.decline')}
            </Button>
          </div>
          <div className={css.feedback} role="status">{error}</div>
        </div>
      </section>
    </div>
  )
}
