import { useMemo, useState } from 'react'
import { Button, IconEditOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingQuestion, PlanReview, QuestionComposerProps } from './contract/slots.ts'
import css from './PlanReviewPanel.module.css'

/** The panel's own props: the question domain face, the narrowed review, and the locale seat. */
export type PlanReviewPanelProps =
  { pending: PendingQuestion; review: PlanReview } & Pick<QuestionComposerProps, 't'>

/**
 * Optional-prop spread for a decision button's tooltip: `title` is optional on
 * the DOM props, and exactOptionalPropertyTypes rejects an explicit undefined.
 *
 * @param description - the asker's option description, when it carries one.
 * @returns The `title` prop to spread, or nothing.
 */
function tooltip(description: string | undefined): { title?: string } {
  return description === undefined ? {} : { title: description }
}

/**
 * Render a plan review as a decision card.
 *
 * @param props - the question domain face, the narrowed plan review, and `t`.
 * @returns The plan-review takeover for this request.
 */
export function PlanReviewPanel({ pending, review, t }: PlanReviewPanelProps) {
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])
  // The panel waits for the host's resolved frame before leaving, so repeated
  // clicks must not resubmit. A failed send re-enables it and shows the error.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settle = (send: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    void send().catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  const decide = (label: string): void => {
    settle(() => pending.answer({ answers: [{ id: review.id, selected: [label] }] }))
  }
  const decline = review.decline

  return (
    <div className={css.frame} data-plan-review-key={pending.key}>
      <section className={css.card} aria-label={review.question}>
        <div className={css.strip}>
          <span className={css.dot} aria-hidden="true" />
          <span className={css.eyebrow}>{t('plan.header')}</span>
        </div>
        <div className={css.body} data-plan-review-scroll>
          <MarkdownText text={review.plan} labels={markdownLabels} />
        </div>
        <div className={css.footer}>
          <div className={css.actions}>
            <Button
              variant="primary" className={css.action} {...tooltip(review.approve.description)}
              disabled={busy} onClick={() => { decide(review.approve.label) }}
            >
              {t('plan.approve')}
            </Button>
            {decline !== undefined && (
              <Button
                variant="outline" className={css.action} {...tooltip(decline.description)}
                disabled={busy} onClick={() => { decide(decline.label) }}
              >
                {t('plan.decline')}
              </Button>
            )}
            <Button
              variant="ghost" className={css.discuss} icon={<IconEditOutline16 size={14} />}
              disabled={busy} onClick={() => { settle(() => pending.cancel()) }}
            >
              {t('plan.discuss')}
            </Button>
          </div>
          <div className={css.feedback} role="status">{error}</div>
        </div>
      </section>
    </div>
  )
}
