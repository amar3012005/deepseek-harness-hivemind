/** React projection of authorized HQ work. Native services own all execution. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  HqWorkspace,
  HqWorkspaceTask,
  HqCalendarItem,
  HqCalendarUpdate,
  HqCalendarUpdateResult,
  HqWakeHistory,
  HqTaskProgress,
} from '@deepseek-ai/dsh-hivemind-hq-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import css from './CompanyWorkspace.module.css'
export interface CompanyWorkspaceProps {
  readonly sessionId: SessionId
  readonly load: (sessionId: SessionId) => Promise<RemoteResult<HqWorkspace>>
  readonly plan: (
    sessionId: SessionId,
    request: HqCalendarUpdate,
  ) => Promise<RemoteResult<HqCalendarUpdateResult>>
  readonly subscribe: (sessionId: SessionId, callback: () => void) => () => void
  readonly progress: (sessionId: SessionId, taskId: string) => Promise<RemoteResult<HqTaskProgress>>
  readonly history: (sessionId: SessionId, id: string) => Promise<RemoteResult<HqWakeHistory>>
  readonly openSession: (sessionId: SessionId) => void
}
export function localDay(instant: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant))
  return ['year', 'month', 'day']
    .map(type => parts.find(part => part.type === type)?.value)
    .join('-')
}
function shift(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}
export function CompanyWorkspace({
  sessionId,
  load,
  plan,
  subscribe,
  openSession,
  history,
  progress,
}: CompanyWorkspaceProps) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const today = localDay(new Date().toISOString(), zone)
  const [anchor, setAnchor] = useState(today)
  const [data, setData] = useState<HqWorkspace | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, select] = useState<string | null>(null)
  const [taskProgress, setTaskProgress] = useState<HqTaskProgress | null>(null)
  const [wakeHistory, setWakeHistory] = useState<HqWakeHistory | null>(null)
  const [tab, setTab] = useState<'week' | 'agenda'>('week')
  const generation = useRef(0)
  const draftId = useRef<string | null>(null)
  const formRef = useRef<HTMLFormElement | null>(null)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const [uncertainWrite, setUncertainWrite] = useState(false)
  const refresh = useCallback(async () => {
    const ticket = ++generation.current
    try {
      const result = await load(sessionId)
      if (ticket !== generation.current) return
      if (result.ok) {
        setData(result.value)
        setError(null)
        setUncertainWrite(false)
        if (draftId.current && result.value.calendar.some(item => item.id === draftId.current)) {
          select(draftId.current)
          draftId.current = null
          formRef.current?.reset()
        }
      } else setError(result.error.message)
    } catch {
      if (ticket === generation.current)
        setError('Workspace state is unconfirmed. Refresh to retry.')
    }
  }, [load, sessionId])
  useEffect(() => {
    setData(null)
    select(null)
    void refresh()
    const dispose = subscribe(sessionId, () => {
      void refresh()
    })
    return () => {
      generation.current++
      dispose()
    }
  }, [sessionId, subscribe, refresh])
  const weekday = new Date(`${anchor}T12:00:00Z`).getUTCDay()
  const monday = shift(anchor, -((weekday + 6) % 7))
  const days = Array.from({ length: 7 }, (_, index) => shift(monday, index))
  const time = (value: string) =>
    new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  const task = data?.tasks.find(item => item.id === selected)
  useEffect(() => {
    if (tab === 'week' && timelineRef.current) timelineRef.current.scrollTop = 8 * 44
  }, [tab, Boolean(data)])
  const wake = data?.wakes.find(item => item.id === selected)
  useEffect(() => {
    setTaskProgress(null)
    if (!task) return
    let current = true
    void progress(sessionId, task.id)
      .then((result) => {
        if (current && result.ok) setTaskProgress(result.value)
      })
      .catch(() => {
        if (current) setError('Employee plan is unavailable. Refresh to retry.')
      })
    return () => {
      current = false
    }
  }, [task, sessionId, progress])
  useEffect(() => {
    setWakeHistory(null)
    if (!wake) return
    let current = true
    void history(sessionId, wake.id)
      .then((result) => {
        if (current && result.ok) setWakeHistory(result.value)
      })
      .catch(() => {
        if (current) setError('Wake history is unavailable.')
      })
    return () => {
      current = false
    }
  }, [wake?.id, sessionId, history])
  const human = data?.calendar.find(item => item.id === selected && item.kind !== 'assignment')
  const window = (value: HqWorkspaceTask) => data?.calendar.find(item => item.taskId === value.id)
  const date = (value: HqWorkspaceTask) => window(value)?.startsAt ?? value.dueAt
  const overdue = (value: HqWorkspaceTask) =>
    value.status !== 'completed' && value.dueAt && Date.parse(value.dueAt) < Date.now()
  const [saving, setSaving] = useState(false)
  const resolveHuman = async (item: HqCalendarItem) => {
    if (saving) return
    setSaving(true)
    try {
      const result = await plan(sessionId, {
        expectedRevision: item.revision,
        item: { ...item, revision: item.revision + 1, resolved: true },
      })
      if (!result.ok) setError(result.error.message)
      else if (!result.value.ok) {
        setError('Calendar changed elsewhere. Current state loaded.')
        await refresh()
      } else await refresh()
    } catch {
      setUncertainWrite(true)
      setError('Calendar write is unconfirmed. Refresh before retrying.')
    } finally {
      setSaving(false)
    }
  }
  const createHuman = async (form: HTMLFormElement) => {
    if (saving) return
    const fields = new FormData(form)
    const start = String(fields.get('start')),
      end = String(fields.get('end'))
    if (!start || !end) return
    setSaving(true)
    try {
      draftId.current ??=
        fields.get('kind') === 'assignment' ? `plan-${String(fields.get('taskId'))}` : randomUUID()
      const prior = data?.calendar.find(item => item.id === draftId.current)
      const item: HqCalendarItem = {
        id: draftId.current,
        revision: (prior?.revision ?? 0) + 1,
        kind: String(fields.get('kind')) as HqCalendarItem['kind'],
        title: String(fields.get('title')),
        owner: String(fields.get('owner')),
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
        resolved: false,
        ...(fields.get('kind') === 'assignment' ? { taskId: String(fields.get('taskId')) } : {}),
      }
      const result = await plan(sessionId, { expectedRevision: prior?.revision ?? 0, item })
      if (!result.ok) setError(result.error.message)
      else if (!result.value.ok) setError('Calendar changed elsewhere. Refresh before retrying.')
      else {
        draftId.current = null
        form.reset()
        await refresh()
        select(item.taskId ?? item.id)
      }
    } catch {
      setUncertainWrite(true)
      setError('Calendar write is unconfirmed. Refresh before creating another entry.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <section className={css.workspace} aria-label="Company workspace">
      <header className={css.header}>
        <div>
          <h1>Company calendar</h1>
          <p>{zone} · Planned time is separate from execution</p>
        </div>
        <button
          onClick={() => {
            void refresh()
          }}
        >
          Refresh workspace
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!data ? (
        <p role="status">Loading authorized company work…</p>
      ) : (
        <>
          <p className={css.banner}>
            Autonomous mode {data.mode.enabled ? 'enabled' : 'paused'} · {data.tasks.length} native
            assignments
          </p>
          <nav className={css.toolbar}>
            <button onClick={() => setTab('week')} aria-pressed={tab === 'week'}>
              Week calendar
            </button>
            <button onClick={() => setTab('agenda')} aria-pressed={tab === 'agenda'}>
              Daily agenda
            </button>
            <button onClick={() => setAnchor(shift(anchor, -7))}>Previous week</button>
            <button onClick={() => setAnchor(today)}>Today</button>
            <button onClick={() => setAnchor(shift(anchor, 7))}>Next week</button>
            <span>
              {days[0]} — {days[6]}
            </span>
          </nav>
          <div className={css.body}>
            <main>
              {tab === 'week' ? (
                <div ref={timelineRef} className={css.timelineViewport}>
                  <div className={css.week}>
                    <section className={css.hours}>
                      <h2>Time</h2>
                      {Array.from({ length: 24 }, (_, hour) => (
                        <div key={hour}>{String(hour).padStart(2, '0')}:00</div>
                      ))}
                    </section>
                    {days.map((day) => {
                      const cards = [
                        ...data.calendar
                          .filter(
                            item =>
                              item.kind !== 'assignment' && localDay(item.startsAt, zone) === day,
                          )
                          .map(item => ({
                            id: item.id,
                            start: item.startsAt,
                            end: item.endsAt,
                            title: item.title,
                            label: `${item.owner} · ${item.resolved ? 'Resolved' : item.kind.replaceAll('_', ' ')}`,
                            kind: 'human',
                          })),
                        ...data.tasks
                          .filter(item => date(item) && localDay(date(item) ?? '', zone) === day)
                          .map(item => ({
                            id: item.id,
                            start: date(item) ?? '',
                            end: window(item)?.endsAt,
                            title: item.title,
                            label: `${window(item) ? 'Planned work' : 'Deadline'} · ${item.owner} · ${item.status}${overdue(item) ? ' · Overdue' : ''}`,
                            kind: 'task',
                          })),
                        ...data.wakes
                          .filter(
                            item =>
                              !item.taskId &&
                              item.status === 'active' &&
                              localDay(item.scheduledAt, zone) === day,
                          )
                          .map(item => ({
                            id: item.id,
                            start: item.scheduledAt,
                            end: undefined,
                            title: item.title,
                            label: `Next wake · ${item.kind}`,
                            kind: 'wake',
                          })),
                      ]
                        .map((item) => {
                          const clock = new Intl.DateTimeFormat('en-GB', {
                            timeZone: zone,
                            hour: '2-digit',
                            minute: '2-digit',
                            hourCycle: 'h23',
                          })
                            .format(new Date(item.start))
                            .split(':')
                          const minute = Number(clock[0]) * 60 + Number(clock[1])
                          const duration = item.end
                            ? Math.min(
                              1440 - minute,
                              Math.max(
                                60,
                                (Date.parse(item.end) - Date.parse(item.start)) / 60000,
                              ),
                            )
                            : 60
                          return { ...item, minute, duration }
                        })
                        .sort((left, right) => left.minute - right.minute)
                      const ends: number[] = []
                      const lanes = cards.map((item) => {
                        let lane = ends.findIndex(end => end <= item.minute)
                        if (lane < 0) lane = ends.length
                        ends[lane] = item.minute + item.duration
                        return lane
                      })
                      return (
                        <section key={day} className={day === today ? css.today : undefined}>
                          <h2>{day}</h2>
                          <div className={css.gridDay}>
                            {cards.map((item, index) => (
                              <button
                                key={item.id}
                                className={
                                  item.kind === 'human'
                                    ? css.human
                                    : item.kind === 'task'
                                      ? css.task
                                      : css.wake
                                }
                                style={{
                                  top: `${(item.minute * 44) / 60}px`,
                                  height: `${(item.duration * 44) / 60}px`,
                                  left: `${((lanes[index] ?? 0) * 100) / Math.max(ends.length, 1)}%`,
                                  width: `${100 / Math.max(ends.length, 1)}%`,
                                }}
                                onClick={() => select(item.id)}
                              >
                                <small>
                                  {time(item.start)}
                                  {item.end ? `–${time(item.end)}` : ''}
                                </small>
                                <strong>{item.title}</strong>
                                {item.label}
                              </button>
                            ))}
                          </div>
                        </section>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <section>
                  <h2>Execution agenda</h2>
                  <h3>Human agenda</h3>
                  {data.calendar
                    .filter(
                      item =>
                        item.kind !== 'assignment' &&
                        !item.resolved &&
                        localDay(item.startsAt, zone) === today,
                    )
                    .map(item => (
                      <button className={css.agenda} key={item.id} onClick={() => select(item.id)}>
                        {time(item.startsAt)} · {item.title} · {item.owner}
                      </button>
                    ))}
                  {data.tasks
                    .filter(item => item.status !== 'completed')
                    .map(item => (
                      <button className={css.agenda} key={item.id} onClick={() => select(item.id)}>
                        <strong>{item.title}</strong> {item.owner} · {item.status}
                        {item.dependencies.length ? ' · Dependencies outstanding' : ''}
                        {overdue(item) ? ' · Overdue' : ''}
                      </button>
                    ))}
                  <h3>Owner decisions and source requests</h3>
                  {data.calendar
                    .filter(
                      item =>
                        !item.resolved && ['decision', 'source_request'].includes(item.kind),
                    )
                    .map(item => (
                      <button className={css.agenda} key={item.id} onClick={() => select(item.id)}>
                        {item.title} · {item.owner}
                      </button>
                    ))}
                  <h3>Unscheduled assignments</h3>
                  {data.tasks
                    .filter(item => !date(item))
                    .map(item => (
                      <button key={item.id} className={css.agenda} onClick={() => select(item.id)}>
                        {item.title}
                      </button>
                    ))}
                </section>
              )}
              <details>
                <summary>Add human work</summary>
                <form
                  ref={formRef}
                  className={css.form}
                  onSubmit={(event) => {
                    event.preventDefault()
                    void createHuman(event.currentTarget)
                  }}
                >
                  <label>
                    Type
                    <select name="kind" aria-label="Type">
                      <option value="meeting">Meeting</option>
                      <option value="decision">Owner decision</option>
                      <option value="source_request">Source request</option>
                      <option value="assignment">Assignment planning window</option>
                    </select>
                  </label>
                  <label>
                    Assignment (planning windows only)
                    <select name="taskId" aria-label="Assignment">
                      {data.tasks
                        .filter(item => item.status === 'pending')
                        .map(item => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Title
                    <input name="title" required maxLength={200} />
                  </label>
                  <label>
                    Owner
                    <input name="owner" required maxLength={100} />
                  </label>
                  <label>
                    Start
                    <input name="start" type="datetime-local" required />
                  </label>
                  <label>
                    End
                    <input name="end" type="datetime-local" required />
                  </label>
                  <button disabled={saving || uncertainWrite}>Save planned work</button>
                </form>
              </details>
            </main>
            <aside className={css.drawer} aria-label="Task details">
              {task ? (
                <>
                  <h2>{task.title}</h2>
                  <p>
                    {task.owner} · {task.status} · revision {task.revision}
                  </p>
                  <h3>Objective</h3>
                  <p>{task.objective}</p>
                  <h3>Planned and actual time</h3>
                  <p>
                    Planned:{' '}
                    {window(task)
                      ? `${window(task)?.startsAt} – ${window(task)?.endsAt}`
                      : 'No execution window'}
                  </p>
                  <p>Deadline: {task.dueAt ?? 'None'}</p>
                  <p>
                    Actual start: {task.startedAt ?? 'Not recorded'} · completion:{' '}
                    {task.completedAt ?? 'Not recorded'}
                  </p>
                  <h3>Authority</h3>
                  <p>
                    {task.authority.join(', ') ||
                      'No write scope recorded. This view grants no additional permission.'}
                  </p>
                  <h3>Dependencies</h3>
                  <p>{task.dependencies.join(', ') || 'None'}</p>
                  <h3>Acceptance criteria</h3>
                  <ul>
                    {task.acceptanceCriteria.map(value => (
                      <li key={value}>{value}</li>
                    ))}
                  </ul>
                  <h3>Employee operating plan</h3>
                  {taskProgress ? (
                    taskProgress.todos.length ? (
                      <ul>
                        {taskProgress.todos.map(item => (
                          <li key={item.content}>
                            {item.status} · {item.content}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>No current plan recorded.</p>
                    )
                  ) : (
                    <p>Loading employee plan…</p>
                  )}
                  <h3>Next wake</h3>
                  <p>{task.nextWakeAt ?? 'No pending assignment wake'}</p>
                  <h3>HQ acceptance review</h3>
                  <p>{task.reviewStatus ?? 'Not reviewed'}</p>
                  <h3>Saved artifact receipts</h3>
                  {task.artifactIds.length ? (
                    <ul>
                      {task.artifactIds.map(id => (
                        <li key={id}>{id}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>No linked saved artifact receipt.</p>
                  )}
                  {task.sessionId && (
                    <button onClick={() => openSession(task.sessionId as SessionId)}>
                      Open employee session
                    </button>
                  )}
                </>
              ) : human ? (
                <>
                  <h2>{human.title}</h2>
                  <p>
                    {human.owner} · {human.kind.replaceAll('_', ' ')}
                  </p>
                  <p>
                    {time(human.startsAt)}–{time(human.endsAt)}
                  </p>
                  <p>{human.resolved ? 'Resolved' : 'Awaiting human action'}</p>
                  {!human.resolved && (
                    <button
                      disabled={saving || uncertainWrite}
                      onClick={() => {
                        void resolveHuman(human)
                      }}
                    >
                      Mark human work resolved
                    </button>
                  )}
                </>
              ) : wake ? (
                <>
                  <h2>{wake.title}</h2>
                  <p>
                    {wake.kind} · {wake.status}
                  </p>
                  <p>Next committed wake: {wake.scheduledAt}</p>
                  <h3>Retained occurrences</h3>
                  {wakeHistory ? (
                    <>
                      {wakeHistory.records.map(record => (
                        <p key={record.messageId}>
                          {record.scheduledAt} · delivered {record.deliveredAt}
                          <br />
                          Inbox receipt: {record.messageId}
                        </p>
                      ))}
                      {wakeHistory.earlierRecordsUnavailable && (
                        <p>Earlier occurrences may be unavailable.</p>
                      )}
                    </>
                  ) : (
                    <p>Loading occurrence receipts…</p>
                  )}
                </>
              ) : (
                <p>Select an assignment, human entry, or wake.</p>
              )}
              <h3>Wake receipts</h3>
              <p>A delivered wake acknowledges inbox delivery, not task completion.</p>
              {data.wakes
                .filter(item => item.deliveredAt)
                .map(item => (
                  <p key={item.id}>
                    {item.title} · delivered {item.deliveredAt}
                  </p>
                ))}
            </aside>
          </div>
        </>
      )}
    </section>
  )
}
