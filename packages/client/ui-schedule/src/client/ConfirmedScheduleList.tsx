/** Confirmed schedule identities joined to the one native authoritative catalog. */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CatalogInjected } from './catalog-source.ts'
import { formatScheduleFrequency } from './schedule-format.ts'
export function ConfirmedScheduleList({ ids, employeeIds, source, open, avatar, t }: {
  ids: readonly ScheduleId[]
  employeeIds?: Readonly<Record<string, string>>
  source: CatalogInjected<ScheduleCatalogEntry>
  open: (task: ScheduleCatalogEntry) => void
  avatar: (owner: SessionId, employeeId?: string) => ReactNode
  t: PropsLocale<'schedule.manager'>['t']
}) {
  const catalog = useSyncExternalStore(source.hooks.catalog.subscribe, source.hooks.catalog.getSnapshot)
  const ordinal = useRef(catalog.readRequest).current
  useEffect(() => { void source.onRetry(ordinal) }, [source, ordinal])
  if (!catalog.settled || catalog.readSettled <= ordinal) return null
  const tasks = catalog.records.filter(task => ids.includes(task.id))
  if (tasks.length === 0) return null
  const technicalCatalog = <section aria-label={t('list.label')} data-confirmed-schedule-list>
    {tasks.map(task => <details key={task.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--dsw-static-neutral-100)' }}>
      <summary style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
        {avatar(task.sessionId, employeeIds?.[task.id])}<span><strong>{task.title}</strong><br />
          <small>{formatScheduleFrequency(task, t)} · {t(task.status === 'active' ? 'status.active' : 'status.inactive')}</small></span>
      </summary>
      <button type="button" onClick={() => { open(task) }}>{t('card.open')}</button>
    </details>)}
  </section>
  return document.documentElement.dataset.dshMode === 'hivemind-chat'
    ? <details><summary>Work details</summary>{technicalCatalog}</details>
    : technicalCatalog
}
