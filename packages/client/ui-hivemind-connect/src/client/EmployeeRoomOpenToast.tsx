import { useEffect, useState, type ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

export const EMPLOYEE_ROOM_OPEN_FAILED = 'hivemind:employee-room-open-failed'

/** App-wide feedback for a refused or failed canonical employee-room open. */
export function EmployeeRoomOpenToast({ t }: PropsLocale<'hivemind-connect'>): ReactNode {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const show = (): void => { setVisible(true) }
    window.addEventListener(EMPLOYEE_ROOM_OPEN_FAILED, show)
    return () => { window.removeEventListener(EMPLOYEE_ROOM_OPEN_FAILED, show) }
  }, [])
  if (!visible) return null
  return <Toast text={t('employee.roomOpenFailed')} icon={<IconWarningOutlineRegular />} onDone={() => { setVisible(false) }} />
}
