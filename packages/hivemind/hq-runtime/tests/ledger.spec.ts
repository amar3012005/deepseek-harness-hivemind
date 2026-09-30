import { describe, expect, it } from 'vitest'
import { companyTaskContract, requireArtifactReceipts, taskContracts, verifiedArtifactLinks } from '../src/ledger.ts'
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
