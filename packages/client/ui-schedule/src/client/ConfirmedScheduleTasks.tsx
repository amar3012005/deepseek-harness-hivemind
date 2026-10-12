/** Scheduled-work receipts joined to the authoritative native task catalog. */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { CatalogInjected } from './catalog-source.ts'
import { formatScheduleFrequency } from './schedule-format.ts'

/** Services shared by the receipt view and native Schedule catalog. */
export type ConfirmedScheduleTasksInjected = Pick<CatalogInjected<ScheduleCatalogEntry>, 'hooks' | 'onRetry'> & {
  readonly openTaskDetail: (sessionId: SessionId, id: ScheduleId) => void
}

/** Inputs of the HIVE-scheduled-work receipt subtree. */
export type ConfirmedScheduleTasksProps = PropsRuntime<'schedule.confirmed.tasks'>
  & PropsRenderSlots<'schedule.task.avatar'>
  & InjectFace<ConfirmedScheduleTasksInjected>
  & PropsLocale<'schedule.manager'>

/** Render delivered task identities with their native records and optional employee avatars. */
export function ConfirmedScheduleTasks(props: ConfirmedScheduleTasksProps): ReactNode {
  const { ids, employeeIds, useCatalog, onRetry, renderSlot, t } = props
  const catalog = useCatalog(snapshot => snapshot)
  const requestAtMount = useRef(catalog.readRequest).current
  useEffect(() => { void onRetry(requestAtMount) }, [onRetry, requestAtMount])

  // The receipt identifies tasks but is not itself the task authority. Wait for a
  // catalog read requested after this receipt view mounted before resolving it.
  if (!catalog.settled || catalog.readSettled <= requestAtMount) return null
  const tasks = catalog.records.filter(task => ids.includes(task.id))
  if (tasks.length === 0) return null

  const taskList = <section aria-label={t('list.label')} data-confirmed-schedule-list>
    {tasks.map(task => <details key={task.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--dsw-static-neutral-100)' }}>
      <summary style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
        {renderSlot('schedule.task.avatar', {
          targetSessionId: task.sessionId,
          ...(employeeIds?.[task.id] === undefined ? {} : { employeeId: employeeIds[task.id] }),
        })}
        <span><strong>{task.title}</strong><br />
          <small>{formatScheduleFrequency(task, t)} · {t(task.status === 'active' ? 'status.active' : 'status.inactive')}</small></span>
      </summary>
      <button type="button" onClick={() => props.openTaskDetail(task.sessionId, task.id)}>{t('card.open')}</button>
    </details>)}
  </section>

  return document.documentElement.dataset.dshMode === 'hivemind-chat'
    ? <details><summary>Work details</summary>{taskList}</details>
    : taskList
}
