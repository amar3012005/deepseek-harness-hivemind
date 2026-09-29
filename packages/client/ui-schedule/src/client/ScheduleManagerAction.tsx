/** Opens the retained task manager from the embedded HyperAgents session. */
import { IconClockOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ScheduleCatalogAction.module.css'

export type ScheduleManagerActionProps = PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<{ readonly title: string; readonly onOpen: () => void }>

export function ScheduleManagerAction({ title, onOpen }: ScheduleManagerActionProps) {
  // HIVE chat and HyperAgents share the embedded Harness composition. The
  // product route is the authority for this OS-only navigation entry.
  if (typeof window === 'undefined'
    || !window.location.pathname.startsWith('/hivemind/app/employee/harness/')) return null

  return <button
    type="button"
    className={css.trigger}
    aria-label={title}
    title={title}
    onClick={onOpen}
  ><IconClockOutline16 size={16} /></button>
}
