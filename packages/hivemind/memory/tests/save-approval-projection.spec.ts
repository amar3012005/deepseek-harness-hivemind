import { describe, expect, it } from 'vitest'
import { memorySaveApprovalProjection } from '../src/save-approval-projection.ts'
import type { MemorySaveApprovalProjectionState } from '../src/save-approval-projection.ts'
import type { SaveCheckpoint } from '../src/index.ts'

describe('HIVE-MIND saved approval projection', () => {
  it('projects a durable prepared save and moves the exact checkpoint to settled on decision', () => {
    const checkpoint: SaveCheckpoint = {
      callId: 'save-call-1', rootCallId: 'root-1', tool: 'hivemind_meta', arguments: { operation: 'save' },
      requests: [{ title: 'Decision', content: 'Keep private memory approval gated.', sourceType: 'decision' }],
      operationId: 'saveop:exact', approvalRequest: { title: 'Decision', content: 'Keep private memory approval gated.', sourceType: 'decision' },
      owner: { orgId: 'org-1', userId: 'user-1', profile: 'hivemind-chat', variation: 'test' }, status: 'pending',
    }
    const event = (status: SaveCheckpoint['status']) => ({ type: 'hivemind/memory-save-checkpoint', data: { ...checkpoint, status } }) as never
    let state: MemorySaveApprovalProjectionState = memorySaveApprovalProjection.init()
    state = memorySaveApprovalProjection.apply(state, event('pending'))
    expect(memorySaveApprovalProjection.wire.view(state)).toMatchObject({ active: [{ callId: 'save-call-1', operationId: 'saveop:exact' }], settled: [] })
    state = memorySaveApprovalProjection.apply(state, event('declined'))
    expect(memorySaveApprovalProjection.wire.view(state)).toMatchObject({ active: [], settled: [{ callId: 'save-call-1', status: 'declined' }] })
    expect(JSON.stringify(memorySaveApprovalProjection.wire.view(state))).not.toContain('user-1')

    // Session projections are pure folds, so the durable log alone is enough
    // to reconstruct the same pending/settled UI after a process restart.
    let restored: MemorySaveApprovalProjectionState = memorySaveApprovalProjection.init()
    for (const persisted of [event('pending'), event('declined')]) restored = memorySaveApprovalProjection.apply(restored, persisted)
    expect(memorySaveApprovalProjection.wire.view(restored)).toEqual(memorySaveApprovalProjection.wire.view(state))
  })
})
