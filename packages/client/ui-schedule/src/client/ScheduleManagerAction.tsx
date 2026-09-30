/** Opens the retained task manager from either embedded Harness mode. */
import { IconClockOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ScheduleCatalogAction.module.css'

export type ScheduleManagerActionProps = PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<{ readonly title: string; readonly onOpen: () => void }>

export function ScheduleManagerAction({ title, onOpen }: ScheduleManagerActionProps) {
  if (typeof window === 'undefined'
    || !/^\/hivemind\/app\/(?:employee\/harness|overview)\/session\//u.test(window.location.pathname)) return null

  return <button
    type="button"
    className={css.trigger}
    aria-label={title}
    title={title}
    onClick={onOpen}
  ><IconClockOutline16 size={16} /></button>
}
