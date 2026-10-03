/** Product identity avatar over the authorized employee directory and room owner. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { EmployeeAvatar, RuntimeAvatar, selectedEmployee, type EmployeeOption } from './HyperagentEmployee.tsx'
export function AgentChatAvatar({ employeeId, name, events, load }: {
  employeeId?: string
  name?: string
  events?: { subscribe(listener: () => void): () => void; getSnapshot(): SessionEventWindow }
  load: () => Promise<EmployeeOption[]>
}) {
  const window = useSyncExternalStore(listener => events?.subscribe(listener) ?? (() => {}), () => events?.getSnapshot())
  const owner = window === undefined ? null : selectedEmployee(window)
  const [directory, setDirectory] = useState<EmployeeOption[]>([])
  useEffect(() => {
    let disposed = false
    void load().then((rows) => {
      if (!disposed) setDirectory(rows)
    }).catch(() => { /* Identity falls back without inventing an avatar. */ })
    return () => { disposed = true }
  }, [load])
  if (employeeId === 'runtime' || (employeeId === undefined && name === undefined && owner === null)) return <RuntimeAvatar size={32} />
  const employee = employeeId === undefined && name === undefined ? owner
    : directory.find(item => item.id === employeeId)
  return employee ? <EmployeeAvatar employee={employee} size={32} />
    : <span aria-hidden style={{ width: 32, height: 32, flexShrink: 0, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--dsw-static-neutral-100)' }}>{name?.slice(0, 1) ?? '?'}</span>
}
