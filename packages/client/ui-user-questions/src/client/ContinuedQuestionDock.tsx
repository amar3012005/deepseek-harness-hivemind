/** Durable unanswered questions use the input dock, never own the composer. */
import { useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingUserQuestion } from '@deepseek-ai/dsh-user-questions/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuestionAnswer, QuestionWait } from './contract/slots.ts'
import type { createQuestionDraftStore } from './draft-store.ts'
import { QuestionComposer } from './QuestionComposer.tsx'
import css from './ContinuedQuestionDock.module.css'

interface ContinuedQuestionActions {
  onAnswer(this: void, callId: PendingUserQuestion['callId'], answer: QuestionAnswer): Promise<boolean>
}

type DockProps = PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'question'> & PropsStore<ReturnType<typeof createQuestionDraftStore>>
  & ContinuedQuestionActions

/** Persisted projection is authoritative; ordinary question dismissal submits nothing; memory decline is an explicit answer. */
export function ContinuedQuestionDock(props: DockProps) {
  const projection = props.useProjection('userQuestions')
  const continued = projection?.active.filter(item => item.state === 'continued') ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const [closed, setClosed] = useState<string | null>(null)
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set())
  const current = continued.find(item => item.callId === selected) ?? continued[0]
  const carrier = useMemo<QuestionWait | undefined>(() => {
    if (current === undefined) return undefined
    const answer = async (batch: QuestionAnswer): Promise<void> => {
      let accepted: boolean
      try {
        accepted = await props.onAnswer(current.callId, batch)
      } catch (error) {
        // A reconnect can rediscover a reply queued before its projection settles.
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'REPLY_QUEUED') {
          setSent(previous => new Set([...previous, current.callId]))
          return
        }
        throw new Error(props.t('durable.failed'))
      }
      if (!accepted) throw new Error(props.t('durable.unavailable'))
      setSent(previous => new Set([...previous, current.callId]))
    }
    return {
      key: `continued:${props.sessionId}:${current.callId}`,
      questions: current.questions,
      autoFocus: false,
      cancel: () => {
        // Destination "Decline" is a decision, whereas ordinary question dismiss remains presentation-only.
        if (current.questions.length === 1 && current.questions[0]?.intent?.kind === 'memory-save-destination') {
          return answer({ answers: [{ id: current.questions[0].id, selected: [] }] })
        }
        setClosed(current.callId)
        return Promise.resolve()
      },
      answer,
    }
  }, [current, props.sessionId, props.onAnswer, props.t])

  if (current === undefined || carrier === undefined) return null
  return <section className={css.dock} data-continued-question aria-label={props.t('durable.waiting')}>
    <div className={css.header}>
      <span role="status">{props.t(sent.has(current.callId) ? 'durable.sent' : 'durable.waiting')}</span>
      {continued.length > 1 && <select aria-label={props.t('durable.choose')} value={current.callId}
        onChange={(event) => { setSelected(event.target.value); setClosed(null) }}>
        {continued.map((item, index) => <option key={item.callId} value={item.callId}>
          {index + 1}. {item.questions[0]?.question}
        </option>)}
      </select>}
    </div>
    {!sent.has(current.callId) && (closed === current.callId
      ? <Button onClick={() => { setClosed(null) }}>{props.t('durable.open')}</Button>
      : <QuestionComposer matched={carrier} t={props.t} useStore={props.useStore} actions={props.actions} />)}
  </section>
}
