import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import { companyTaskContract, verifiedArtifactLinks } from '../src/ledger.ts'

function coldReorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(coldReorder)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, coldReorder(item)]))
}
function mount() {
  const producerEvents = [{ type: 'hivemind/generation-created', seq: 9, data: { artifactId: 'report' } },
    { type: 'hivemind/generation-created', seq: 10, data: { artifactId: 'revision' } }]
  const contract = companyTaskContract({ taskId: 'task-1', dueAt: '2030-01-01T10:00:00Z', acceptanceCriteria: ['One saved report', 'Source citations'] })
  const links = verifiedArtifactLinks(producerEvents, 'task-1', ['report'], 'ravi-session')
  const events = [{ type: 'hivemind/hq-task-contract', data: coldReorder(contract) },
    { type: 'hivemind/hq-task-artifacts', data: coldReorder(links) }] as unknown as SessionEvent[]
  const append = vi.fn((type: string, data: unknown) => events.push({ type, data } as SessionEvent))
  const agent = { id: 'root', session: { snapshotEvents: () => events, append } } as unknown as Agent
  const flush = vi.fn(async () => true)
  const ensure = vi.fn(async () => ({ id: 'deadline' }))
  let tool: ToolDefinition
  const ctx = {
    effect: (callback: () => unknown) => callback(), on: () => () => {},
    tools: { register: (definition: ToolDefinition) => { tool = definition } },
    agentTeams: { guardTaskUpdates: () => () => {}, membership: () => ({ role: 'lead', root: agent }),
      getTask: () => ({ id: 'task-1', status: 'in_progress', subject: 'Report' }),
      listMembers: () => [{ name: 'ravi', id: 'ravi-session' }, { name: 'other', id: 'other-session' }] },
    agents: { get: () => undefined }, sessions: { flush }, schedule: { ensure },
    sessionPersistence: { open: async () => ({ read: async () => ({ events: producerEvents }), close: async () => {} }) },
  } as unknown as Context
  apply(ctx)
  const execute = (args: Record<string, unknown>) => tool!.execute(args, { agent, signal: new AbortController().signal } as never)
  return { execute, append, flush, ensure, contract, events }
}
describe('native HQ durable receipt replay', () => {
  it('reuses reordered cold artifact links while still checkpointing', async () => {
    const fixture = mount()
    await fixture.execute({ action: 'artifacts', task_id: 'task-1', producer: 'ravi', artifact_ids: ['report'] })
    await fixture.execute({ action: 'artifacts', task_id: 'task-1', producer: 'ravi', artifact_ids: ['report'] })
    expect(fixture.append).not.toHaveBeenCalled()
    expect(fixture.flush).toHaveBeenCalledTimes(2)
  })
  it('preserves existing normalized cold contract replay and rejects changed criteria', async () => {
    const fixture = mount()
    const input = { action: 'attach', task_id: 'task-1', due_at: fixture.contract.dueAt, acceptance_criteria: [...fixture.contract.acceptanceCriteria] }
    await fixture.execute(input)
    expect(fixture.append).not.toHaveBeenCalled()
    expect(fixture.flush).toHaveBeenCalledTimes(1)
    expect(fixture.ensure).toHaveBeenCalledTimes(1)
    await expect(fixture.execute({ ...input, acceptance_criteria: [...fixture.contract.acceptanceCriteria].reverse() })).rejects.toThrow('hq_contract_exists')
  })
  it('records changed verified artifacts and producer evidence, rejects missing receipts', async () => {
    const fixture = mount()
    await fixture.execute({ action: 'artifacts', task_id: 'task-1', producer: 'ravi', artifact_ids: ['revision'] })
    expect(fixture.append).toHaveBeenCalledTimes(1)
    await fixture.execute({ action: 'artifacts', task_id: 'task-1', producer: 'other', artifact_ids: ['revision'] })
    expect(fixture.append).toHaveBeenCalledTimes(2)
    await expect(fixture.execute({ action: 'artifacts', task_id: 'task-1', producer: 'ravi', artifact_ids: ['missing'] })).rejects.toThrow('hq_artifact_receipt_required')
    expect(fixture.append).toHaveBeenCalledTimes(2)
  })
  it('preserves artifact array order rather than treating links as a set', async () => {
    const fixture = mount()
    await fixture.execute({ action: 'artifacts', task_id: 'task-1', producer: 'ravi', artifact_ids: ['report', 'revision'] })
    await fixture.execute({ action: 'artifacts', task_id: 'task-1', producer: 'ravi', artifact_ids: ['report', 'revision'] })
    expect(fixture.append).toHaveBeenCalledTimes(1)
    await fixture.execute({ action: 'artifacts', task_id: 'task-1', producer: 'ravi', artifact_ids: ['revision', 'report'] })
    expect(fixture.append).toHaveBeenCalledTimes(2)
  })
  it('does not hide a failed persistence checkpoint on identical replay', async () => {
    const fixture = mount()
    fixture.flush.mockResolvedValue(false)
    await expect(fixture.execute({ action: 'artifacts', task_id: 'task-1', producer: 'ravi', artifact_ids: ['report'] })).rejects.toThrow('hq_artifact_link_persistence_required')
    expect(fixture.append).not.toHaveBeenCalled()
  })
})
