/** Shared native task/calendar presentation; supplied state remains authoritative. */
import type { ReactNode } from 'react'
import type { HqWorkspaceTask } from '@deepseek-ai/dsh-hivemind-hq-runtime/client'
import css from './RuntimePlanSummary.module.css'
export interface RuntimeTaskCardProps {
  task: HqWorkspaceTask
  employeeName: string
  avatar?: ReactNode
  startsAt?: string
  endsAt?: string
  cancel?: () => void
  cancelling?: boolean
  busy?: boolean
}
export function RuntimeTaskCard({ task, employeeName, avatar, startsAt, endsAt, cancel, cancelling, busy }: RuntimeTaskCardProps) {
  const start = startsAt ?? task.nextWakeAt
  const calendarDate = start ?? task.dueAt
  const date = calendarDate === undefined ? undefined : new Date(calendarDate)
  const format = (value: string) => new Date(value).toLocaleString(undefined, { timeZoneName: 'short' })
  const completed = task.status === 'completed'
  const status = completed ? 'Completed' : task.status === 'deleted' ? 'Cancelled'
    : task.status === 'pending' ? (start ? 'Scheduled' : 'Assigned') : task.status === 'in_progress' ? 'In progress' : task.status
  return <article className={css.task}>
    {completed && <span className={css.completedIcon} aria-hidden>✓</span>}
    {!completed && date && <div className={css.date} aria-hidden>
      <small>{date.toLocaleString(undefined, { month: 'short' })}</small><strong>{date.getDate()}</strong>
    </div>}
    <div className={css.identity}>{avatar}</div>
    <div className={css.body}><strong>{task.title}</strong>
      <div className={css.meta}>{employeeName} · <span className={completed ? css.completedLabel : undefined}>{status}</span></div>
      {completed && <details className={css.history}><summary>Past schedule</summary>
        {start && <div className={css.meta}>Started {format(start)}</div>}
        {endsAt && <div className={css.meta}>Work window ended {format(endsAt)}</div>}
        {task.dueAt && <div className={css.meta}>Original deadline {format(task.dueAt)}</div>}
      </details>}
      {!completed && start && <div className={css.meta}>Starts {format(start)}</div>}
      {!completed && endsAt && <div className={css.meta}>Work window ends {format(endsAt)}</div>}
      {!completed && task.dueAt && <div className={css.meta}>Due {format(task.dueAt)}</div>}
    </div>
    {task.status === 'pending' && cancel && <button className={css.cancel} type="button" disabled={busy} onClick={cancel}>
      {cancelling ? 'Cancelling…' : 'Cancel'}
    </button>}
  </article>
}
