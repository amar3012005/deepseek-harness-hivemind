/** Host-only persistent-assignee contract; browser types stay service-free. */
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

/** Durable session identity for externally executed persistent assignees. */
export interface ExternalPersistentAssignee {
  readonly kind: 'external-persistent-assignee'
  readonly id: SessionId
  readonly session: Session
  readonly status: 'idle'
  readonly employeeId: string
  readonly dotId: string
}
