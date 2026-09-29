/** Optional transactional storage provider for hosted, tenant-isolated Schedule deployments. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ScheduleId } from './types.ts'
import type { ScheduleTask } from './storage.ts'

/** One transaction's task view; writes update both the durable store and this view. */
export interface ScheduleTaskTable {
  entries(): IterableIterator<[ScheduleId, ScheduleTask]>
  get(id: ScheduleId): ScheduleTask | undefined
  put(id: ScheduleId, task: ScheduleTask): Promise<void>
  delete(id: ScheduleId): Promise<unknown>
}

/** Authenticated management and trusted delivery use separately scoped transactions. */
export interface ScheduleBackend {
  manage<T>(work: (tasks: ScheduleTaskTable) => Promise<T>): Promise<T>
  dispatch(work: (tasks: ScheduleTaskTable) => Promise<void>): Promise<boolean>
  allowsAgent(agent: Agent): boolean
  start(wake: () => void): () => void
}
