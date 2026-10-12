import { describe, expect, it } from 'vitest'
import { employeeDispatchAllowed, employeeCloseoutAllowed, employeeCloseoutToolAllowed } from '../src/lifecycle.ts'
const profile = { id: 'dummy-employee', status: 'running', policy_rules: {
  native_lifecycle: { version: 1, phase: 'active', kind: 'temporary', expires_at: '2030-01-01T00:00:00Z' },
} }
describe('current employee dispatch authority', () => {
  it('requires a current visible profile and stops at the exact deadline', () => {
    expect(employeeDispatchAllowed(undefined, 0)).toBe(false)
    expect(employeeDispatchAllowed(profile, 0)).toBe(true)
    expect(employeeDispatchAllowed(profile, Date.parse('2030-01-01T00:00:00Z'))).toBe(false)
  })
  it('rejects archived, paused and unsupported lifecycle records without changing old profiles', () => {
    expect(employeeDispatchAllowed({ ...profile, archived_at: '2029-01-01' }, 0)).toBe(false)
    expect(employeeDispatchAllowed({ ...profile, status: 'paused' }, 0)).toBe(false)
    expect(employeeDispatchAllowed({ ...profile, policy_rules: { native_lifecycle: { version: 2 } } }, 0)).toBe(false)
    expect(employeeDispatchAllowed({ id: 'legacy', status: 'running' }, 0)).toBe(true)
    expect(employeeDispatchAllowed({ ...profile, policy_rules: { native_lifecycle: 'invalid' } }, 0)).toBe(false)
    expect(employeeDispatchAllowed({ ...profile, policy_rules: { native_lifecycle: { version: 1, phase: 'active', kind: 'unknown' } } }, 0)).toBe(false)
  })
})

it('closing preserves evidence tools but denies business dispatch and research', () => {
  const closing = { ...profile, policy_rules: { native_lifecycle: { version: 1, phase: 'closing', kind: 'temporary' } } }
  expect(employeeDispatchAllowed(closing, 0)).toBe(false)
  expect(employeeCloseoutAllowed(closing)).toBe(true)
  expect(employeeCloseoutToolAllowed('hyperagents_memory', { action: 'save', kind: 'handoff' })).toBe(true)
  expect(employeeCloseoutToolAllowed('hivemind_artifact_inspect')).toBe(true)
  expect(employeeCloseoutToolAllowed('hivemind_agent_message', { recipient: 'runtime', kind: 'update' })).toBe(true)
  expect(employeeCloseoutToolAllowed('hivemind_generate')).toBe(false)
  expect(employeeCloseoutToolAllowed('web_search')).toBe(false)
  expect(employeeCloseoutToolAllowed('hivemind_agent_message', { recipient: 'other', kind: 'question' })).toBe(false)
  expect(employeeCloseoutToolAllowed('hyperagents_memory', { action: 'save', kind: 'decision_note' })).toBe(false)
  expect(employeeCloseoutAllowed({ ...closing, archived_at: '2030-01-01' })).toBe(false)
})

it('permits bounded closeout at a valid temporary deadline, never malformed or archived policy', () => {
  expect(employeeCloseoutAllowed(profile, Date.parse('2030-01-01T00:00:00Z'))).toBe(true)
  expect(employeeCloseoutAllowed(profile, 0)).toBe(false)
  expect(employeeCloseoutAllowed({ ...profile, policy_rules: { native_lifecycle: { version: 1, phase: 'active', kind: 'temporary', expires_at: 'invalid' } } }, 0)).toBe(false)
})
