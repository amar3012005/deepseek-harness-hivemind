import { useEffect, useState, type ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

export const EMPLOYEE_ROOM_OPEN_FAILED = 'hivemind:employee-room-open-failed'
export const BRAIN_SESSION_OPEN_FAILED = 'hivemind:brain-session-open-failed'

/** App-wide feedback for a refused or failed canonical employee-room open. */
export function EmployeeRoomOpenToast({ t }: PropsLocale<'hivemind-connect'>): ReactNode {
  const [message, setMessage] = useState<'employee.roomOpenFailed' | 'brain.sessionOpenFailed'>()
  useEffect(() => {
    const showEmployee = (): void => { setMessage('employee.roomOpenFailed') }
    const showBrain = (): void => { setMessage('brain.sessionOpenFailed') }
    window.addEventListener(EMPLOYEE_ROOM_OPEN_FAILED, showEmployee)
    window.addEventListener(BRAIN_SESSION_OPEN_FAILED, showBrain)
    return () => {
      window.removeEventListener(EMPLOYEE_ROOM_OPEN_FAILED, showEmployee)
      window.removeEventListener(BRAIN_SESSION_OPEN_FAILED, showBrain)
    }
  }, [])
  if (message === undefined) return null
  return <Toast text={t(message)} icon={<IconWarningOutlineRegular />} onDone={() => { setMessage(undefined) }} />
}
