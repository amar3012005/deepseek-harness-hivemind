import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ScheduleTask } from './storage.ts'
import type { Context } from '@deepseek-ai/cordis'

/** Durable tenant and actor identity for product-owned Schedule rows. */
export interface ScheduleOwnership {
  readonly orgId: string
  /** User whose session-storage scope owns the bound native Session. */
  readonly userId: string
  /** Authenticated user who created/last managed a shared organization task. */
  readonly actorUserId: string
  readonly audience: 'personal' | 'team'
}

/** Product authorization seam around native Schedule management and delivery. */
export interface ScheduleOwnershipPolicy {
  /** Validate the current request principal and exact Session binding. */
  bind(sessionId: SessionId): Promise<ScheduleOwnership>
  /** Enforce product retention limits before inserting a new native task. */
  assertCanCreate(owner: ScheduleOwnership): Promise<void>
  /** Revalidate management access against current membership/session ownership. */
  authorize(sessionId: SessionId, owner: ScheduleOwnership): Promise<boolean>
  /** Whether the current authenticated principal may see this row. */
  visible(task: ScheduleTask): Promise<boolean>
  /** Restore and revalidate the saved owner for the full native delivery operation. */
  runAsOwner<T>(task: ScheduleTask, work: () => Promise<T>): Promise<T>
}

declare module '@deepseek-ai/cordis' {
  interface Context { scheduleOwnership?: ScheduleOwnershipPolicy }
}

/** Resolve the optional hosted ownership policy installed by a product adapter. */
export function scheduleOwnershipOf(ctx: Context): ScheduleOwnershipPolicy | undefined {
  return ctx.get('scheduleOwnership')
}
