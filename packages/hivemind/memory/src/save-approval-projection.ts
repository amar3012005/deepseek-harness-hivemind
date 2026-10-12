/** Durable, client-readable state for prepared HIVE-MIND memory saves. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SaveCheckpoint } from './index.ts'

export interface MemorySaveApprovalItem {
  readonly callId: string
  readonly operationId?: string | undefined
  readonly tool: string
  readonly status: SaveCheckpoint['status']
  readonly requests: readonly { readonly title: string; readonly content: string; readonly project?: string | undefined }[]
  readonly destination?: 'personal' | 'organization' | 'project' | undefined
  readonly result?: unknown | undefined
}

/** Client-safe approval descriptor that omits internal save results. */
export type MemorySaveApprovalViewItem = Omit<MemorySaveApprovalItem, 'result'>

export interface MemorySaveApprovalProjectionState {
  readonly items: readonly MemorySaveApprovalItem[]
}

export interface MemorySaveApprovalProjectionView {
  readonly active: readonly MemorySaveApprovalViewItem[]
  readonly settled: readonly MemorySaveApprovalViewItem[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    hivemindMemorySaveApprovals: MemorySaveApprovalProjectionState
  }
  interface SessionProjectionMap {
    hivemindMemorySaveApprovals: MemorySaveApprovalProjectionView
  }
}

const itemSchema = z.object({
  callId: z.string().min(1),
  operationId: z.string().optional(),
  tool: z.string().min(1),
  status: z.enum(['pending', 'approved', 'executing', 'declined', 'completed', 'failed']),
  requests: z.array(z.object({ title: z.string(), content: z.string(), project: z.string().optional() }).strict()),
  destination: z.enum(['personal', 'organization', 'project']).optional(),
  result: z.unknown().optional(),
}).strict()

const stateSchema: z.ZodType<MemorySaveApprovalProjectionState> = z.object({
  items: z.array(itemSchema),
}).strict()

const viewItemSchema: z.ZodType<MemorySaveApprovalViewItem> = itemSchema.omit({ result: true })
const viewSchema: z.ZodType<MemorySaveApprovalProjectionView> = z.object({
  active: z.array(viewItemSchema),
  settled: z.array(viewItemSchema),
}).strict()

function fromCheckpoint(checkpoint: SaveCheckpoint): MemorySaveApprovalItem {
  return {
    callId: checkpoint.callId,
    ...(checkpoint.operationId === undefined ? {} : { operationId: checkpoint.operationId }),
    tool: checkpoint.tool,
    status: checkpoint.status,
    requests: checkpoint.requests.map(request => ({
      title: request.title,
      content: request.content,
      ...(request.project === undefined ? {} : { project: request.project }),
    })),
    ...(checkpoint.destination === undefined ? {} : { destination: checkpoint.destination }),
    ...(checkpoint.result === undefined ? {} : { result: checkpoint.result }),
  }
}

export const memorySaveApprovalProjection = {
  key: 'hivemindMemorySaveApprovals',
  stateSchema,
  init: () => ({ items: [] }),
  apply: (state: MemorySaveApprovalProjectionState, event: SessionEvent) => {
    if (event.type !== 'hivemind/memory-save-checkpoint') return state
    const next = fromCheckpoint(event.data as SaveCheckpoint)
    const index = state.items.findIndex(item => item.callId === next.callId)
    const items = [...state.items]
    if (index < 0) items.push(next)
    else items[index] = next
    return { items }
  },
  wire: {
    viewSchema,
    view: (state: MemorySaveApprovalProjectionState): MemorySaveApprovalProjectionView => {
      const publicItem = ({ result: _result, ...item }: MemorySaveApprovalItem): MemorySaveApprovalViewItem => item
      return {
        active: state.items.filter(item => item.status === 'pending' || item.status === 'approved' || item.status === 'executing').map(publicItem),
        settled: state.items.filter(item => item.status === 'declined' || item.status === 'completed' || item.status === 'failed').map(publicItem),
      }
    },
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'hivemindMemorySaveApprovals', MemorySaveApprovalProjectionState>
