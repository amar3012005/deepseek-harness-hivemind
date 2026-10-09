import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
const mocks = vi.hoisted(() => ({ allowed: vi.fn(), root: vi.fn(), deliver: vi.fn() }))
vi.mock('../src/employee-room.ts', async original => ({ ...await original<typeof import('../src/employee-room.ts')>(),
  allowsEmployeeWork: mocks.allowed, authenticatedRoot: mocks.root, rooms: () => ({ deliverAgentMessage: mocks.deliver }) }))
import { installDelegatedBlockerReporting } from '../src/delegated-blocker.ts'
import { employeeReportReceipt } from '../src/employee-report-repair.ts'

async function fixture(adapter: MockAdapter, direct = false) {
  const path = await mkdtemp(join(tmpdir(), 'employee-repair-'))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: path }); await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  mocks.allowed.mockReset().mockResolvedValue(true); mocks.deliver.mockReset().mockResolvedValue({ messageId: 'report-receipt' })
  const task = { id: 'task-1', ownerName: 'analyst', revision: 2, status: 'in_progress' }
  ctx.provide('agentTeams', { getTask: () => task } as never)
  const chief = await ctx.agents.create({ sessionId: SessionId('chief') })
  mocks.root.mockReset().mockResolvedValue(chief.agent)
  const employee = await ctx.agents.create({ sessionId: SessionId('employee'), agentOptions: { provider: 'mock', model: 'mock' } })
  chief.agent.session.append('hivemind/hq-employee-assignment', { taskId: 'task-1', employeeId: 'employee', sessionId: employee.agent.id, memberName: 'analyst', personaSha256: 'digest' })
  ctx.on('agent/pre-step', async ({ agent, turn, messages }, next) => {
    const result = await next()
    if (!direct && messages.some(m => m.source.kind === 'hivemind-agent-message')) agent.session.append('hivemind/employee-work-origin', { turn, rootId: 'chief', taskId: 'task-1' })
    return result
  })
  installDelegatedBlockerReporting(ctx)
  const message = () => createUserMessage({ source: direct ? { kind: 'user' } : { kind: 'hivemind-agent-message', messageId: 'assignment', senderId: chief.agent.id, senderSessionId: chief.agent.id }, content: [{ type: 'text', text: direct ? 'Direct work.' : JSON.stringify({ text: 'HQ_EMPLOYEE_ASSIGNMENT={"rootId":"chief","taskId":"task-1"}\nPrepare the final label; required code is missing.' }) }] })
  return { ctx, chief, employee, task, path, message, async close() {
    await employee.dispose(); await chief.dispose(); await ctx.fiber.dispose()
    await rm(path, { recursive: true, force: true })
  } }
}

it('actual native stopping boundary repairs omitted tool into a successful existing blocker checkpoint', async () => {
  const adapter = new MockAdapter([textResponse('The code is missing.'), toolCallResponse('blocked-call', 'hivemind_employee_blocker', { blocker_key: 'required-code', question: 'What is the exact project reference code?' }), textResponse('Reported the saved blocker to Runtime.')])
  const f = await fixture(adapter)
  try {
    f.employee.agent.followup(f.message()); await vi.waitFor(() => expect(f.employee.agent.status).toBe('idle'))
    expect(adapter.requests).toHaveLength(2)
    expect(f.employee.agent.session.ownEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'plugin' && e.data.source.plugin === 'hivemind-hq/employee-report-repair')).toHaveLength(1)
    expect(f.chief.agent.session.ownEvents().filter(e => e.type === 'hivemind/hq-delegated-blocker')).toHaveLength(1)
    expect(f.employee.agent.session.ownEvents().filter(e => e.type === 'hivemind/connected-receipt')).toHaveLength(1)
    expect(mocks.deliver).toHaveBeenCalledTimes(1)
    expect(f.task.status).toBe('in_progress')
    expect(employeeReportReceipt(f.employee.agent, 1, 'task-1')).toBe(true)
  } finally { await f.close() }
})

it.each(['human_input', 'permission'] as const)('a delegated %s reports a durable blocker and becomes idle without opening human wait', async (kind) => {
  const name = kind === 'human_input' ? 'ask_user_question' : 'external_write'
  const adapter = new MockAdapter([toolCallResponse('question-call', name, { question: 'Which workbook?' })])
  const f = await fixture(adapter)
  const ask = vi.fn(async () => ({}))
  f.ctx.tools.register(defineTool({ name, description: 'Ask the human',
    parameters: { question: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] }, execute: ask }))
  if (kind === 'permission') f.ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'Native write approval required' }))
  try {
    f.employee.agent.followup(f.message())
    await vi.waitFor(() => expect(f.employee.agent.status).toBe('idle'))
    expect(ask).not.toHaveBeenCalled()
    expect(adapter.requests).toHaveLength(1)
    expect(f.employee.agent.session.ownEvents().findLast(event => event.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'blocked' } })
    expect(f.employee.agent.session.ownEvents().filter(event => event.type === 'hivemind/hq-employee-blocked')).toHaveLength(1)
    expect(mocks.deliver).toHaveBeenCalledTimes(1)
    expect(f.task.status).toBe('in_progress')
  } finally { await f.close() }
})

it('double omission makes only one correction and one incomplete Runtime report, never a fabricated blocker', async () => {
  const adapter = new MockAdapter([textResponse('Missing input.'), textResponse('Still missing input.')]); const f = await fixture(adapter)
  try {
    f.employee.agent.followup(f.message()); await vi.waitFor(() => expect(f.employee.agent.status).toBe('idle'))
    expect(adapter.requests).toHaveLength(2); expect(mocks.deliver).toHaveBeenCalledTimes(1)
    expect(mocks.deliver.mock.calls[0]?.[1]).toMatchObject({ target: 'runtime', taskId: 'task-1', kind: 'update' })
    expect(mocks.deliver.mock.calls[0]?.[1].text).toContain('remains incomplete')
    expect(f.chief.agent.session.ownEvents().some(e => e.type === 'hivemind/hq-delegated-blocker')).toBe(false)
    expect(f.task.status).toBe('in_progress')
    const corrections = f.employee.agent.session.ownEvents().filter(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.source.kind === 'plugin' && m.source.plugin === 'hivemind-hq/employee-report-repair'))
    expect(corrections).toHaveLength(1)
  } finally { await f.close() }
})

it.each(['direct', 'revoked', 'reassigned', 'completed'] as const)('leaves %s work unchanged at stopping boundary', async (kind) => {
  const adapter = new MockAdapter([textResponse('Ordinary response.')]); const f = await fixture(adapter, kind === 'direct')
  try {
    if (kind === 'revoked') mocks.allowed.mockResolvedValue(false)
    if (kind === 'reassigned') mocks.allowed.mockRejectedValue(new Error('hq_assignment_target_not_authorized'))
    if (kind === 'completed') f.task.status = 'completed'
    f.employee.agent.followup(f.message()); await vi.waitFor(() => expect(f.employee.agent.status).toBe('idle'))
    expect(adapter.requests).toHaveLength(1); expect(mocks.deliver).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('a durable prior correction marker prevents a second steer when the same stopping boundary is retried', async () => {
  const adapter = new MockAdapter([textResponse('Still cannot provide a saved receipt.')]); const f = await fixture(adapter)
  try {
    // Existing logged plugin envelope is what survives native cold restoration;
    // no process-local counter or new event vocabulary owns the bound.
    f.employee.agent.inject(createUserMessage({ source: { kind: 'plugin', plugin: 'hivemind-hq/employee-report-repair' }, content: [{ type: 'text', text: 'HQ_EMPLOYEE_REPORT_REPAIR=chief:task-1:1\nExisting one bounded correction.' }] }))
    await f.ctx.sessions.flush(f.employee.agent.session)
    f.employee.agent.followup(f.message()); await vi.waitFor(() => expect(f.employee.agent.status).toBe('idle'))
    expect(adapter.requests).toHaveLength(1); expect(mocks.deliver).toHaveBeenCalledTimes(1)
    expect(mocks.deliver.mock.calls[0]?.[1].text).toContain('remains incomplete')
  } finally { await f.close() }
})
