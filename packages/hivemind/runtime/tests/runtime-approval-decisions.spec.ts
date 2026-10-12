import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { reconcileExecutingApproval, RuntimeApprovalService, type RuntimeApprovalCheckpoint } from '../src/runtime-approval-checkpoints.ts'
import { runtimeApprovalProjection, type RuntimeApprovalProjectionState } from '../src/runtime-approval-projection.ts'

const principal = { orgId: 'org-1', userId: 'admin-1', profile: 'hivemind-chat' as const, variation: 'prod',
  authenticatedActor: { orgId: 'org-1', userId: 'admin-1', role: 'admin' as const } }

async function fixture(flush: (count: number) => boolean | Promise<boolean>) {
  const ctx = new Context()
  await ctx.plugin(Sessions)
  ctx.sessions.registerMessageProjection({ type: 'tool/parked', project: () => new Map() })
  ctx.provide('hivemindExecutionScope', { require: () => principal } as never)
  const session = ctx.sessions.create(SessionId('runtime-approval-decision'))
  session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' })
  session.append('hivemind/session-owner', { id: null, slug: 'runtime', name: 'Runtime', role: 'Chief' } as never)
  const checkpoint: RuntimeApprovalCheckpoint = {
    approvalId: 'approval-1', callId: 'tool-call-1', rootCallId: 'root-call-1', toolName: 'sensitive_action',
    arguments: { recipient: 'private@example.com' },
    argumentsDigest: createHash('sha256').update('{"recipient":"private@example.com"}').digest('hex'),
    owner: { sessionId: String(session.id), orgId: 'org-1', userId: 'admin-1', profile: 'hivemind-chat', variation: 'prod' }, state: 'pending',
  }
  session.append('hivemind/runtime-approval-checkpoint', checkpoint)
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(checkpoint.callId), name: checkpoint.toolName,
    arguments: JSON.stringify(checkpoint.arguments) })
  session.append('tool/parked', { turn: 1, step: 1, callId: ToolCallId(checkpoint.callId),
    rootCallId: ToolCallId(checkpoint.rootCallId), name: checkpoint.toolName,
    approvalId: checkpoint.approvalId, argumentsDigest: checkpoint.argumentsDigest })
  const steer = vi.fn((_message: UserMessage) => {})
  const agent = { id: 'root-agent', session, ctx, steer } as unknown as Agent
  ctx.provide('tools', { get: (name: string) => ({ name }) } as never)
  ctx.provide('agents', { get: () => agent, roots: () => [agent] } as never)
  let calls = 0
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async () => flush(++calls))
  return { ctx, session, agent, steer, service: new RuntimeApprovalService(ctx) }
}

it('recovers a failed final decision flush, then emits the exact typed continuation once', async () => {
  const f = await fixture(count => count !== 2)
  try {
    await expect(f.service.decide(f.agent, 'tool-call-1', 'approval-1', 'decline'))
      .rejects.toThrow('runtime_approval_decision_not_persisted')
    expect(f.steer).not.toHaveBeenCalled()

    await expect(f.service.decide(f.agent, 'tool-call-1', 'approval-1', 'decline')).resolves.toBe(true)
    expect(f.steer).toHaveBeenCalledOnce()
    const continuation = f.steer.mock.calls[0]?.[0]
    expect(continuation).toBeDefined()
    if (!continuation) throw new Error('expected approval continuation')
    expect(continuation.source).toMatchObject({ kind: 'hivemind-runtime-approval', action: 'declined',
      approvalId: 'approval-1', callId: 'tool-call-1' })

    await expect(f.service.decide(f.agent, 'tool-call-1', 'approval-1', 'decline')).resolves.toBe(true)
    expect(f.steer).toHaveBeenCalledOnce()
  } finally { await f.ctx.fiber.dispose() }
})

it('serializes conflicting concurrent administrator decisions and rechecks the checkpoint', async () => {
  const f = await fixture(async () => { await new Promise(resolve => setTimeout(resolve, 0)); return true })
  try {
    const approve = f.service.decide(f.agent, 'tool-call-1', 'approval-1', 'approve')
    const decline = f.service.decide(f.agent, 'tool-call-1', 'approval-1', 'decline')
    const declinedConflict = expect(decline).rejects.toThrow('runtime_approval_decision_conflict')
    await expect(approve).resolves.toBe(true)
    await declinedConflict
    expect(f.session.snapshotEvents().filter(event => event.type === 'hivemind/runtime-approval-checkpoint').at(-1)?.data)
      .toMatchObject({ state: 'approved', decision: 'approve', decisionStatus: 'committed' })
  } finally { await f.ctx.fiber.dispose() }
})

it('does not mistake the original parked tool result for a post-claim native result', async () => {
  const f = await fixture(async () => true)
  try {
    const saved = f.session.snapshotEvents().findLast(event => event.type === 'hivemind/runtime-approval-checkpoint')!.data as RuntimeApprovalCheckpoint
    const args = JSON.stringify(saved.arguments)
    f.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(saved.callId), name: saved.toolName, arguments: args })
    f.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId: ToolCallId(saved.callId), content: [{ type: 'text', text: 'pending approval receipt' }], isError: false,
    }) }, { surfaceOp: 'append' })
    const executing = { ...saved, state: 'executing' as const, decision: 'approve' as const, decisionStatus: 'committed' as const }
    f.session.append('hivemind/runtime-approval-checkpoint', executing)
    expect(reconcileExecutingApproval(executing, f.session.snapshotEvents())).toBeUndefined()

    f.session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({
      callId: ToolCallId(saved.callId), content: [{ type: 'text', text: 'native action result' }], isError: false,
    }) }, { surfaceOp: 'append' })
    expect(reconcileExecutingApproval(executing, f.session.snapshotEvents())).toMatchObject({
      state: 'completed', resultSource: 'native-tool-result',
    })
  } finally { await f.ctx.fiber.dispose() }
})

it('keeps the checkpoint projection bounded to active calls and replays the same view', async () => {
  const f = await fixture(async () => true)
  try {
    let events = f.session.snapshotEvents()
    let state: RuntimeApprovalProjectionState = runtimeApprovalProjection.init()
    for (const event of events) state = runtimeApprovalProjection.apply(state, event)
    const first = runtimeApprovalProjection.wire.view(state)
    for (let index = 0; index < 12; index++) {
      const terminal = { ...(events.findLast(event => event.type === 'hivemind/runtime-approval-checkpoint')!.data as RuntimeApprovalCheckpoint),
        callId: `terminal-${index}`, approvalId: `approval-${index}`, state: 'completed' as const }
      f.session.append('hivemind/runtime-approval-checkpoint', terminal)
    }
    const checkpoint = events.findLast(event => event.type === 'hivemind/runtime-approval-checkpoint')!.data as RuntimeApprovalCheckpoint
    f.session.append('hivemind/runtime-approval-checkpoint', { ...checkpoint, state: 'blocked' })
    events = f.session.snapshotEvents()
    state = runtimeApprovalProjection.init()
    for (const event of events) state = runtimeApprovalProjection.apply(state, event)
    expect(runtimeApprovalProjection.wire.view(state).activeCallIds).toEqual(['tool-call-1'])
    expect(runtimeApprovalProjection.wire.view(state)).toEqual(first)
  } finally { await f.ctx.fiber.dispose() }
})
