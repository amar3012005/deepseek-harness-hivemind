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
function mount(inspectSavedPdf?: ReturnType<typeof vi.fn>) {
  const producerEvents = [{ type: 'hivemind/generation-created', seq: 9, data: { artifactId: 'report' } },
    { type: 'hivemind/generation-created', seq: 10, data: { artifactId: 'revision' } },
    { type: 'tool/call', data: { callId: 'saved', name: 'hivemind_generate', arguments: JSON.stringify({ content: '# Saved report' }) } },
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'saved', content: [{ type: 'text', text: JSON.stringify({ artifact_id: 'report' }) }] }] } } }]
  const contract = companyTaskContract({ taskId: 'task-1', dueAt: '2030-01-01T10:00:00Z', acceptanceCriteria: ['One saved report', 'Source citations'] })
  const links = verifiedArtifactLinks(producerEvents, 'task-1', ['report'], 'ravi-session')
  const events = [{ type: 'hivemind/hq-task-contract', data: coldReorder(contract) },
    { type: 'hivemind/hq-task-artifacts', data: coldReorder(links) }] as unknown as SessionEvent[]
  const append = vi.fn((type: string, data: unknown) => events.push({ type, data } as SessionEvent))
  const agent = { id: 'root', session: { snapshotEvents: () => events, ownEvents: () => events, append } } as unknown as Agent
  const flush = vi.fn(async () => true)
  const ensure = vi.fn(async () => ({ id: 'deadline' }))
  let role = 'lead'
  let guard: (caller: Agent, request: { action: string; taskId: string; expectedRevision: number }) => unknown
  let tool: ToolDefinition
  const ctx = {
    effect: (callback: () => unknown) => callback(), on: () => () => {},
    tools: { register: (definition: ToolDefinition) => { tool = definition }, restrict: () => () => {} },
    agentTeams: { guardTaskUpdates: (value: typeof guard) => { guard = value; return () => {} }, membership: () => ({ role, root: agent }),
      getTask: () => ({ id: 'task-1', status: 'in_progress', subject: 'Report', revision: 2, description: 'Saved report', writeScopes: [] }),
      listMembers: () => [{ name: 'ravi', id: 'ravi-session' }, { name: 'other', id: 'other-session' }] },
    get: () => inspectSavedPdf ? { inspectSavedPdf } : undefined,
    agents: { get: () => undefined }, sessions: { flush }, schedule: { ensure },
    sessionPersistence: { open: async () => ({ read: async () => ({ events: producerEvents }), close: async () => {} }) },
  } as unknown as Context
  apply(ctx)
  const execute = (args: Record<string, unknown>) => tool!.execute(args, { agent, signal: new AbortController().signal } as never)
  return { execute, append, flush, ensure, contract, events, producerEvents, complete: () => guard(agent, { action: 'complete', taskId: 'task-1', expectedRevision: 2 }), setRole: (value: string) => { role = value } }
}
describe('native HQ durable receipt replay', () => {
  it('records Runtime decisions, preserves acceptance after advisory, and rejects stale inputs or teammates', async () => {
    const f = mount()
    const inspected = await f.execute({ action: 'inspect', task_id: 'task-1' }) as { evidence_hash: string; task_revision: number }
    const input = { action: 'decide', task_id: 'task-1', decision: 'accepted', rationale: 'The saved report satisfies the contract.', task_revision: inspected.task_revision, evidence_hash: inspected.evidence_hash }
    expect(f.complete()).toBeTypeOf('string')
    await expect(f.execute({ ...input, evidence_hash: 'stale' })).rejects.toThrow('hq_review_evidence_changed')
    await expect(f.execute({ ...input, task_revision: 1 })).rejects.toThrow('hq_review_task_changed')
    await f.execute(input)
    expect(f.complete()).toBeUndefined()
    f.events.push({ type: 'hivemind/hq-task-review', data: { taskId: 'task-1', reviewer: 'jev', status: 'uncertain' } } as SessionEvent)
    expect(f.complete()).toBeUndefined()
    await f.execute({ ...input, decision: 'needs_changes', rationale: 'The requested source citation is missing.' })
    expect(f.complete()).toBeTypeOf('string')
    f.setRole('teammate')
    await expect(f.execute(input)).rejects.toThrow('hq_lead_required')
  })
  it('inspects existing validated PDFs without changing the review fingerprint', async () => {
    const inspect = vi.fn(async (_file: unknown, _signal: unknown, _pages?: unknown) => ({ page_count: 2, preview_page: 1, preview: { attachmentId: 'pixels' } }))
    const f = mount(inspect)
    f.producerEvents.splice(0, f.producerEvents.length, { type: 'hivemind/generation-created', seq: 9,
      data: { artifactId: 'report', mediaType: 'application/pdf',
        file: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'report.pdf', bytes: 42 } } } as never)
    const first = await f.execute({ action: 'inspect', task_id: 'task-1', pdf_pages: [1, 2] }) as { evidence_hash: string; documents: unknown[] }
    expect(first.documents[0]).toMatchObject({ pdf_inspection: { page_count: 2, preview_page: 1 } })
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(inspect.mock.calls[0]?.[2]).toEqual([1, 2])
    const second = await f.execute({ action: 'inspect', task_id: 'task-1' }) as { evidence_hash: string }
    expect(second.evidence_hash).toBe(first.evidence_hash)
    await f.execute({ action: 'decide', task_id: 'task-1', decision: 'accepted', rationale: 'PDF pixels match the brief.',
      task_revision: 2, evidence_hash: first.evidence_hash })
    expect(inspect).toHaveBeenCalledTimes(2)
  })
  it('reports a missing PDF renderer and rejects invalid page requests without reading pixels', async () => {
    const f = mount()
    f.producerEvents.splice(0, f.producerEvents.length, { type: 'hivemind/generation-created', seq: 9,
      data: { artifactId: 'report', mediaType: 'application/pdf',
        file: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'report.pdf', bytes: 42 } } } as never)
    const result = await f.execute({ action: 'inspect', task_id: 'task-1' }) as { documents: unknown[] }
    expect(result.documents[0]).toMatchObject({ pdf_inspection: { limitation: 'PDF renderer unavailable; actual pages were not inspected' } })
    await expect(f.execute({ action: 'inspect', task_id: 'task-1', pdf_pages: [0] })).rejects.toThrow('hq_pdf_pages_invalid')
    await expect(f.execute({ action: 'inspect', task_id: 'task-1', pdf_pages: [1, 1] })).rejects.toThrow('hq_pdf_pages_invalid')
  })
  it('inspects and decides a committed binary without claiming text extraction', async () => {
    const f = mount()
    f.producerEvents.splice(0, f.producerEvents.length, { type: 'hivemind/generation-created', seq: 9, data: { artifactId: 'report', mediaType: 'image/png', file: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'report.png', bytes: 42 } } } as never)
    const inspected = await f.execute({ action: 'inspect', task_id: 'task-1' }) as { evidence_hash: string; task_revision: number; documents: { text: string; attachment: { modality: string } }[] }
    expect(inspected.documents[0]).toMatchObject({ text: '', attachment: { modality: 'image' } })
    await expect(f.execute({ action: 'review', task_id: 'task-1' })).rejects.toThrow('hq_jev_advisory_requires_text_evidence')
    await f.execute({ action: 'decide', task_id: 'task-1', decision: 'needs_changes', rationale: 'Actual pixel inspection is unavailable; receipt alone is insufficient.', task_revision: inspected.task_revision, evidence_hash: inspected.evidence_hash })
    expect(f.complete()).toBeTypeOf('string')
  })
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
