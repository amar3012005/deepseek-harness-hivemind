/** Product identity avatar over the authorized employee directory and room owner. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { EmployeeAvatar, RuntimeAvatar, selectedEmployee, projectedEmployee, type EmployeeOption } from './HyperagentEmployee.tsx'
export function AgentChatAvatar({ employeeId, name, events, identity, load }: {
  employeeId?: string
  name?: string
  events?: { subscribe(listener: () => void): () => void; getSnapshot(): SessionEventWindow }
  identity?: { subscribe(listener: () => void): () => void; getSnapshot(): string | null | undefined }
  load: () => Promise<EmployeeOption[]>
}) {
  const window = useSyncExternalStore(listener => events?.subscribe(listener) ?? (() => {}), () => events?.getSnapshot())
  const savedIdentity = useSyncExternalStore(listener => identity?.subscribe(listener) ?? (() => {}), () => identity?.getSnapshot())
  const owner = projectedEmployee(savedIdentity) ?? (window === undefined ? null : selectedEmployee(window))
  const [directory, setDirectory] = useState<EmployeeOption[]>([])
  useEffect(() => {
    let disposed = false
    void load().then((rows) => {
      if (!disposed) setDirectory(rows)
    }).catch(() => { /* Identity falls back without inventing an avatar. */ })
    return () => { disposed = true }
  }, [load])
  const avatar = (content: import('react').ReactNode) => <span data-chat-agent-avatar style={{ width: 32, flexShrink: 0, alignSelf: 'flex-end' }}>{content}</span>
  if (employeeId === 'runtime' || (employeeId === undefined && name === undefined && owner === null)) return avatar(<RuntimeAvatar size={32} />)
  const employee = employeeId === undefined && name === undefined ? owner
    : directory.find(item => item.id === employeeId)
  return avatar(employee ? <EmployeeAvatar employee={employee} size={32} />
    : <span aria-hidden style={{ width: 32, height: 32, flexShrink: 0, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--dsw-static-neutral-100)' }}>{name?.slice(0, 1) ?? '?'}</span>)
}
