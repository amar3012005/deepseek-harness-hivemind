// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeSignalRow } from '../src/client/chat/RuntimeSignalRow.tsx'
import { avatarGroupEnds } from '../src/client/chat/avatar-groups.ts'
import { hivemindFailureText, isQuestionAnswerSubmission } from '../src/client/chat/hivemind-presentation.ts'
import { pendingRuntimeSignals, runtimeSignal } from '../src/client/chat/runtime-signal.ts'

afterEach(() => cleanup())

describe('HIVE chat presentation', () => {
  it('keeps queued and received Runtime states distinct and passive', () => {
    const signal = runtimeSignal({ kind: 'hivemind-runtime-event', eventId: 'event-1', action: 'wake' })!
    const { rerender } = render(<RuntimeSignalRow signal={signal} pending />)
    expect(screen.getByText('Waiting for Runtime')).toBeTruthy()
    expect(screen.queryByText(/processing/i)).toBeNull()
    rerender(<RuntimeSignalRow signal={signal} pending={false} />)
    expect(screen.getByText('Received by Runtime')).toBeTruthy()
  })

  it('deduplicates inbox echoes once their durable context message is present', () => {
    const source = { kind: 'hivemind-runtime-event', eventId: 'event-1', action: 'notify' }
    const queue = [{ source }, { source }, { source: { kind: 'user' } }]
    expect(pendingRuntimeSignals(queue, new Set())).toHaveLength(1)
    expect(pendingRuntimeSignals(queue, new Set(['event-1']))).toEqual([])
  })

  it('hides host-authored question receipts and provider details from HIVE failure copy', () => {
    expect(isQuestionAnswerSubmission({ kind: 'user', questionAnswerSubmission: true })).toBe(true)
    expect(isQuestionAnswerSubmission({ kind: 'user' })).toBe(false)
    expect(hivemindFailureText('AUTH')).not.toMatch(/credential|token|provider/i)
    expect(hivemindFailureText('secret-provider-payload')).toContain('conversation is saved')
    expect(hivemindFailureText('secret-provider-payload')).not.toContain('secret-provider-payload')
  })

  it('ends each consecutive teammate or Runtime avatar group at its last bubble', () => {
    expect([...avatarGroupEnds([
      { key: 'employee-1', speaker: 'employee' },
      { key: 'employee-2', speaker: 'employee' },
      { key: 'runtime-1', speaker: 'runtime' },
      { key: 'human', boundary: true },
      { key: 'runtime-2', speaker: 'runtime' },
    ])]).toEqual(['employee-2', 'runtime-1', 'runtime-2'])
  })
})
