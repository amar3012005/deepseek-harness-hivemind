/** Bounded read-only projection of exact-call approvals that still protect context. */
import { z } from 'zod'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { RuntimeApprovalCheckpoint, RuntimeApprovalState } from './runtime-approval-checkpoints.ts'

export interface RuntimeApprovalProjectionState {
  readonly items: readonly { readonly callId: string; readonly state: RuntimeApprovalState }[]
}
export interface RuntimeApprovalProjectionView {
  readonly activeCallIds: readonly string[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { hivemindRuntimeApprovals: RuntimeApprovalProjectionState }
  interface SessionProjectionMap { hivemindRuntimeApprovals: RuntimeApprovalProjectionView }
}

const itemSchema = z.object({ callId: z.string().min(1), state: z.enum(['pending', 'approved', 'declined', 'executing', 'completed', 'failed', 'blocked']) }).strict()
const stateSchema: z.ZodType<RuntimeApprovalProjectionState> = z.object({ items: z.array(itemSchema) }).strict()
const viewSchema: z.ZodType<RuntimeApprovalProjectionView> = z.object({ activeCallIds: z.array(z.string()) }).strict()

export const runtimeApprovalProjection = {
  key: 'hivemindRuntimeApprovals',
  stateSchema,
  init: () => ({ items: [] }),
  apply(state: RuntimeApprovalProjectionState, event: SessionEvent) {
    if (event.type !== 'hivemind/runtime-approval-checkpoint') return state
    const checkpoint = event.data as RuntimeApprovalCheckpoint
    const items = state.items.filter(item => item.callId !== checkpoint.callId)
    if (['declined', 'completed', 'failed'].includes(checkpoint.state)) return { items }
    const item = { callId: checkpoint.callId, state: checkpoint.state }
    items.push(item)
    return { items }
  },
  wire: {
    viewSchema,
    view: (state: RuntimeApprovalProjectionState): RuntimeApprovalProjectionView => ({
      activeCallIds: state.items.map(item => item.callId),
    }),
  },
  stateVersion: 2,
} satisfies ProjectionDefinition<'hivemindRuntimeApprovals', RuntimeApprovalProjectionState>

/** Remove a suspended invocation only from provider history; durable/UI events remain untouched. */
export const runtimeParkedCallMessageProjection: SessionMessageProjection<'tool/parked'> = {
  type: 'tool/parked',
  project(event, context) {
    const { callId, rootCallId, name, approvalId, argumentsDigest, turn, step } = event.data
    if (!callId || !rootCallId || !name || !approvalId || !/^[a-f0-9]{64}$/.test(argumentsDigest)) {
      throw new Error('tool/parked: invalid exact-call identity')
    }
    if (callId !== rootCallId) {
      const nested = context.events.some(candidate => candidate.type === 'tool/ptc-dispatch-start'
        && candidate.data.subCallId === callId && candidate.data.rootCallId === rootCallId
        && candidate.data.name === name)
      if (!nested) throw new Error('tool/parked: matching native PTC dispatch is missing')
      return new Map()
    }
    const callIndex = context.events.findLastIndex(candidate => candidate.type === 'tool/call'
      && candidate.data.callId === callId && candidate.data.turn === turn && candidate.data.step === step
      && candidate.data.name === name)
    if (callIndex < 0) throw new Error('tool/parked: matching tool/call is missing')
    const assistantIndex = context.events.findLastIndex((candidate, index) => index < callIndex
      && candidate.type === 'assistant/message' && candidate.data.turn === turn && candidate.data.step === step
      && candidate.data.message.content.some(block => block.type === 'tool-call' && block.id === callId))
    const assistant = context.events[assistantIndex]
    if (!assistant || assistant.type !== 'assistant/message') throw new Error('tool/parked: matching assistant invocation is missing')
    const seq = assistant.seq as SessionSeq
    const current = context.messages.get(seq) ?? assistant.data.message
    const content = current.content.filter(block => block.type !== 'tool-call' || block.id !== callId)
    if (content.length === current.content.length) throw new Error('tool/parked: invocation was already projected')
    if (content.length === 0) content.push({
      type: 'text',
      text: 'A tool action is suspended pending an authenticated Runtime decision. It has not executed.',
    })
    const projected: Message = { ...current, content }
    return new Map([[seq, projected]])
  },
}
