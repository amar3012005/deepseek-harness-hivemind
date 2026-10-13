import { describe, expect, it } from 'vitest'
import { admissionFailedBeforeWork, companyTaskContract, requireArtifactReceipts, taskContracts, verifiedArtifactLinks, artifactProducer } from '../src/ledger.ts'
const contract = () => companyTaskContract({ taskId: 'task-1', acceptanceCriteria: ['One saved report'], dueAt: '2026-10-01T10:00:00+02:00' })
describe('HQ metadata over native Team tasks', () => {
  it('restores immutable requirements without another task lifecycle', () => {
    expect(taskContracts([{ type: 'hivemind/hq-task-contract', data: contract() }])[0]?.dueAt).toBe('2026-10-01T08:00:00.000Z')
  })
  it('rejects timezone ambiguity and invalid task identities', () => {
    expect(() => companyTaskContract({ ...contract(), dueAt: '2026-10-01T10:00:00' })).toThrow('hq_invalid_due_at')
    expect(() => companyTaskContract({ ...contract(), taskId: 'invented' })).toThrow('hq_invalid_task_id')
  })
  it('requires task correlation and saved producer receipts', () => {
    const linked = { type: 'hivemind/hq-task-artifacts', data: { taskId: 'task-1', artifactIds: ['report'] } }
    expect(() => requireArtifactReceipts([linked], 'task-1')).toThrow('hq_artifact_receipt_required')
    const saved = { type: 'hivemind/generation-created', data: { artifactId: 'report' } }
    expect(() => requireArtifactReceipts([saved, linked], 'task-1')).not.toThrow()
    expect(() => requireArtifactReceipts([saved, linked], 'task-2')).toThrow('hq_artifact_receipt_required')
  })
  it('rejects silent rewriting of committed acceptance criteria', () => {
    const event = { type: 'hivemind/hq-task-contract', data: contract() }
    expect(() => taskContracts([event, event])).toThrow('hq_duplicate_contract_record')
  })
  it('imports committed employee receipts without trusting artifact names in prose', () => {
    const source = { type: 'hivemind/generation-created', seq: 7, data: { artifactId: 'employee-report' } }
    const link = verifiedArtifactLinks([source], 'task-1', ['employee-report'], 'employee-session')
    expect(link.producerReceipts).toEqual([{ artifactId: 'employee-report', sessionId: 'employee-session', sourceSeq: 7, sourceType: 'hivemind/generation-created' }])
    expect(() => requireArtifactReceipts([{ type: 'hivemind/hq-task-artifacts', data: link }], 'task-1')).not.toThrow()
    expect(() => verifiedArtifactLinks([{ type: 'assistant/message', seq: 7, data: { artifactId: 'employee-report' } }], 'task-1', ['employee-report'], 'employee-session')).toThrow('hq_artifact_receipt_required')
  })
  it('fails closed on malformed receipt payloads without treating them as saved artifacts', () => {
    const saved = { type: 'hivemind/generation-created', data: { artifactId: 'report' } }
    for (const artifactIds of [undefined, null, 'report', [3], []]) {
      const link = { type: 'hivemind/hq-task-artifacts', data: { taskId: 'task-1', artifactIds } }
      expect(() => requireArtifactReceipts([saved, link], 'task-1')).toThrow('hq_artifact_receipt_required')
    }
    expect(() => requireArtifactReceipts([{ type: 'hivemind/generation-created', data: null }], 'task-1')).toThrow('hq_artifact_receipt_required')
  })
})


describe('HQ reconciles admission failure without replaying accepted effects', () => {
  const failed = { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Harness credit admission failed: Invalid credit operation identity' } } } }
  const queued = { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'initial' }] } }
  const consumed = { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } }
  it('allows a bounded retry only after admission failed before acceptance', () => {
    expect(admissionFailedBeforeWork([queued, consumed, failed])).toBe(true)
    expect(admissionFailedBeforeWork([queued, failed])).toBe(false)
    expect(admissionFailedBeforeWork([])).toBe(false)
  })
  it('never retries model-visible messages, tool effects, or artifacts', () => {
    for (const type of ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'hivemind/artifact-created'])
      expect(admissionFailedBeforeWork([queued, consumed, { type, data: {} }, failed])).toBe(false)
    expect(admissionFailedBeforeWork([{ ...failed, data: { reason: { kind: 'error', error: { message: 'unknown' } } } }])).toBe(false)
  })
})

describe('task-owned omitted artifact producer', () => {
  const members = [{ id: 'runtime-room', name: 'lead' }, { id: 'mimi-room', name: 'employee-canonical-slug' }]
  const task = { id: 'task-24', ownerName: 'employee-canonical-slug' }
  const events = [
    { type: 'team/task', data: { task: { id: task.id, ownerId: 'mimi-room' } } },
    { type: 'hivemind/hq-employee-assignment', data: { taskId: task.id, sessionId: 'mimi-room', memberName: task.ownerName } },
  ]
  it('uses the exact current native owner rather than defaulting a delegated artifact to lead', () => {
    expect(artifactProducer(events, task, members)).toBe(members[1])
    const link = verifiedArtifactLinks([{ type: 'hivemind/generation-created', seq: 1909, data: { artifactId: 'saved-html' } }],
      task.id, ['saved-html'], artifactProducer(events, task, members).id)
    expect(link.producerReceipts).toEqual([{ artifactId: 'saved-html', sessionId: 'mimi-room', sourceSeq: 1909,
      sourceType: 'hivemind/generation-created' }])
  })
  it('retains explicit producer behavior and uses lead only for an unassigned task', () => {
    expect(artifactProducer(events, task, members, 'lead')).toBe(members[0])
    expect(artifactProducer([], { id: 'unassigned' }, members)).toBe(members[0])
    expect(() => artifactProducer(events, task, members, 'Mimi')).toThrow('producer_not_member')
  })
  it('rejects stale assignments, foreign membership and missing durable task ownership', () => {
    expect(() => artifactProducer(events, task, [members[0]!])).toThrow('owner_conflict')
    expect(() => artifactProducer([], task, members)).toThrow('owner_conflict')
    expect(() => artifactProducer([...events, { type: 'team/task', data: { task: { id: task.id, ownerId: 'runtime-room' } } }],
      { ...task, ownerName: 'lead' }, members)).toThrow('owner_conflict')
    expect(() => artifactProducer(events, { ...task, ownerName: 'wrong-slug' }, members)).toThrow('owner_conflict')
  })
  it('does not infer or register a receipt from an artifact GUID or completion narrative', () => {
    expect(() => verifiedArtifactLinks([{ type: 'assistant/message', seq: 1910, data: { artifactId: 'saved-html' } }],
      task.id, ['saved-html'], artifactProducer(events, task, members).id)).toThrow('artifact_receipt_required')
  })
})
