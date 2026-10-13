/** Bounded saved task discovery; inspection owns full artifact evidence. */
import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { employeeDispatchAllowed } from '@deepseek-ai/dsh-hivemind-employee-directory'
import type { CompanyTaskContract } from './ledger.ts'
import type { HqCalendarItem } from './types.ts'

interface ListSource {
  events: readonly SessionEvent[]
  profiles: readonly Record<string, JsonValue>[]
  tasks: readonly { id: string; revision: number; subject: string; status: string }[]
  contracts: readonly CompanyTaskContract[]
  calendar: readonly HqCalendarItem[]
  runtimeDispatches: readonly JsonValue[]
}
interface ListRequest { task_id?: string; cursor?: string; limit?: number; refresh_dispatches?: boolean }
interface ListBounds { listPageSize: number; listResultMaxBytes: number }

/**
 * Project a complete byte-bounded page without modifying saved records.
 * @param source - Already authorized roster and native task records.
 * @param request - Optional exact task or revision-bound continuation cursor.
 * @param bounds - Deployment-owned item and complete-result byte budgets.
 * @returns Saved current heads, counts and the next discovery cursor.
 */
export function contractListPage(source: ListSource, request: ListRequest, bounds: ListBounds): Record<string, JsonValue> {
  const limit = request.limit ?? bounds.listPageSize
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw Error('hq_list_limit_must_be_1_to_25')
  if (request.task_id && !source.tasks.some(task => task.id === request.task_id)) throw Error('hq_task_not_found')
  const revision = createHash('sha256').update(JSON.stringify([
    source.events.findLast(event => ['team/task', 'hivemind/hq-task-contract', 'hivemind/hq-task-artifacts', 'hivemind/hq-task-review', 'hivemind/hq-calendar-item'].includes(event.type))?.seq ?? 0,
    source.profiles.map(profile => profile['id']), source.tasks.map(task => [task.id, task.revision, task.status]),
    request.task_id ?? null,
  ])).digest('hex').slice(0, 16)
  let offset = 0
  if (request.cursor !== undefined) {
    const match = /^([a-f0-9]{16}):(0|[1-9][0-9]*)$/.exec(request.cursor)
    if (!match || match[1] !== revision || !Number.isSafeInteger(Number(match[2]))) throw Error('hq_list_cursor_changed_read_first_page')
    offset = Number(match[2])
  }
  const tasks = source.tasks.filter(task => !request.task_id || task.id === request.task_id)
    .sort((a, b) => Number(['completed', 'deleted'].includes(a.status)) - Number(['completed', 'deleted'].includes(b.status)))
  const profiles = request.task_id ? [] : source.profiles
  const calendar = source.calendar.filter(item => !request.task_id || item.taskId === request.task_id)
  const total = Math.max(tasks.length, profiles.length, calendar.length)
  if (offset > total) throw Error('hq_list_cursor_out_of_range')
  const clip = (value: unknown) => String(value ?? '').slice(0, 200)
  const links = new Map<string, Extract<SessionEvent, { type: 'hivemind/hq-task-artifacts' }>['data']>()
  const reviews = new Map<string, Extract<SessionEvent, { type: 'hivemind/hq-task-review' }>['data']>()
  for (const event of source.events) {
    if (event.type === 'hivemind/hq-task-artifacts') links.set(event.data.taskId, event.data)
    if (event.type === 'hivemind/hq-task-review') reviews.set(event.data.taskId, event.data)
  }
  for (let size = limit; size >= 1; size--) {
    const pageTasks = tasks.slice(offset, offset + size)
    const ids = new Set(pageTasks.map(task => task.id))
    const result = {
      revision, next_cursor: offset + size < total ? `${revision}:${offset + size}` : null,
      totals: { employees: profiles.length, tasks: tasks.length, calendar: calendar.length },
      summaries: true, dispatch_status: request.refresh_dispatches === true ? 'requested' : 'not_requested',
      next: 'Use task_id for an exact saved task, next_cursor for more heads, or inspect for full linked artifact evidence. Summaries do not establish completion.',
      employees: profiles.slice(offset, offset + size).map(profile => ({
        id: typeof profile['id'] === 'string' ? profile['id'] : null, name: clip(profile['name']), slug: typeof profile['slug'] === 'string' ? profile['slug'] : null,
        role: clip(profile['role_archetype'] ?? profile['role']), nativeDispatchAvailable: employeeDispatchAllowed(profile),
      })),
      tasks: pageTasks.map(task => ({ task_id: task.id, revision: task.revision, subject: clip(task.subject), status: task.status })),
      contracts: source.contracts.filter(item => ids.has(item.taskId)).map(item => ({
        taskId: item.taskId, dueAt: item.dueAt, acceptanceCriteria: item.acceptanceCriteria.slice(0, 4).map(clip),
        acceptance_criteria_count: item.acceptanceCriteria.length,
      })),
      artifact_receipts: [...links.values()].filter(item => ids.has(item.taskId)).map(item => ({
        task_id: item.taskId, artifact_ids: item.artifactIds.slice(0, 4), artifact_count: item.artifactIds.length,
        producer_receipt_count: item.producerReceipts?.length ?? 0,
      })),
      reviews: [...reviews.values()].filter(item => ids.has(item.taskId)).map(item => ({
        task_id: item.taskId, task_revision: item.taskRevision, status: item.status,
        artifact_ids: item.artifactIds.slice(0, 4), artifact_count: item.artifactIds.length,
      })),
      runtime_dispatches: source.runtimeDispatches.filter(item => item !== null && typeof item === 'object'
        && !Array.isArray(item) && ids.has(String(item['task_id']))),
      calendar: calendar.slice(offset, offset + size).map(item => ({
        id: item.id, revision: item.revision, kind: item.kind, title: clip(item.title), owner: item.owner,
        startsAt: item.startsAt, endsAt: item.endsAt, resolved: item.resolved, taskId: item.taskId ?? null,
      })),
    }
    if (Buffer.byteLength(JSON.stringify(result)) <= bounds.listResultMaxBytes) return result
  }
  throw Error('hq_list_item_exceeds_result_budget_use_inspect')
}
