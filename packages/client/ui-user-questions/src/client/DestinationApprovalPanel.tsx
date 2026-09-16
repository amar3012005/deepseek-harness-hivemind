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
          <span className={css.dot} />
          {t('save.header')}
        </div>
        <div className={css.body}>
          <p>{destination.question}</p>
          {destination.detail ? <p>{destination.detail}</p> : null}
          <div role="radiogroup" aria-label={t('save.header')}>
            {destination.options.map(option => (
              <Button
                key={option.label}
                variant={selected === option.label ? 'primary' : 'outline'}
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
          <div className={css.feedback} role="status">{error}</div>
          <div className={css.actions}>
            <Button variant="ghost" disabled={busy} onClick={() => { settle(() => pending.cancel()) }}>
              {t('save.decline')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || selected === null}
              onClick={() => {
                if (selected === null) return
                settle(() => pending.answer({ answers: [{ id: destination.id, selected: [selected] }] }))
              }}
            >
              {t('save.submit')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
