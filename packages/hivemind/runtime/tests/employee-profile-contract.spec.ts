import { expect, it, vi } from 'vitest'
import { validateEmployeeProfileFields, lifecycleBusinessError, employeeLifecycleTool, confirmedEmployeeDeadlineSchedule, validateEmployeeLifecycleInput, lifecycleErrorGuidance } from '../src/employee-lifecycle.ts'
it('matches Core profile bounds without truncating user responsibilities', () => {
  for (const [field, limit] of [['name', 100], ['role', 40], ['persona', 12000]] as const) {
    expect(() => validateEmployeeProfileFields({ [field]: 'a'.repeat(limit) })).not.toThrow()
    expect(() => validateEmployeeProfileFields({ [field]: 'a'.repeat(limit + 1) })).toThrow(`invalid_${field}`)
    expect(() => validateEmployeeProfileFields({ [field]: ' ' })).toThrow(`invalid_${field}`)
  }
  expect(() => validateEmployeeProfileFields({ role: 'Lifecycle Check (bounded verification responsibility)' })).toThrow('invalid_role')
  expect(() => validateEmployeeProfileFields({ role: 'Bounded internal release-readiness checklist verifier' })).toThrow('invalid_role')
  expect(() => validateEmployeeProfileFields({ role: 'Release readiness verifier', persona: 'Bounded internal release-readiness checklist verification.' })).not.toThrow()
})
it('exposes only known lifecycle business codes, never arbitrary response text', () => {
  expect(lifecycleBusinessError({ error: 'invalid_role' })).toBe('invalid_role')
  expect(lifecycleBusinessError({ error: 'employee_profile_revision_conflict' })).toBe('employee_profile_revision_conflict')
  expect(lifecycleBusinessError({ error: 'token secret; invalid_role' })).toBeUndefined()
  expect(lifecycleBusinessError({ error: 'Employee lifecycle unavailable', token: 'secret' })).toBeUndefined()
  expect(lifecycleBusinessError('invalid_role')).toBeUndefined()
})

it('rejects oversized profile input locally before any lifecycle request', async () => {
  const send = vi.fn()
  const tool = employeeLifecycleTool(send)
  await expect(tool.execute({ operation: 'configure', role: 'a'.repeat(41) }, { signal: new AbortController().signal } as never)).rejects.toThrow('invalid_role')
  expect(send).not.toHaveBeenCalled()
})

it('uses only the exact Core-confirmed temporary deadline receipt without a second producer', () => {
  const ready = { status: 'ready', employeeId: 'employee', scheduleId: 'schedule-native' }
  expect(confirmedEmployeeDeadlineSchedule('employee', ready)).toBe('schedule-native')
  for (const receipt of [undefined, null, { ...ready, status: 'pending' }, { ...ready, employeeId: 'other' }, { ...ready, scheduleId: '' }]) {
    expect(confirmedEmployeeDeadlineSchedule('employee', receipt)).toBeUndefined()
  }
})

const employeeId = '9a8e4dbc-a1d6-4608-82d7-ef05a262a419'
it('rejects the observed slug and creation-key identities before requesting Core', async () => {
  const send = vi.fn()
  const tool = employeeLifecycleTool(send)
  for (const employee_id of ['employee-d509ee752701ffa614b7928d', 'employee-deadline-e2e-20261006-2049', employeeId.replace('9a8e', 'zzzz')]) {
    await expect(tool.execute({ operation: 'inspect_closeout', employee_id }, { signal: new AbortController().signal } as never)).rejects.toThrow('copy the employee.id UUID')
  }
  expect(send).not.toHaveBeenCalled()
})
it('requires exact operation-specific revisions instead of manufacturing defaults', () => {
  for (const operation of ['begin_closeout', 'archive', 'configure']) {
    expect(() => validateEmployeeLifecycleInput({ operation, employee_id: employeeId, ...(operation === 'configure' ? { role: 'Finance specialist' } : {}) })).toThrow('missing_employee_revision')
  }
  expect(() => validateEmployeeLifecycleInput({ operation: 'configure', employee_id: employeeId, expected_revision: 2, role: 'Financial baseline support', persona: 'User-agreed responsibilities' })).toThrow('expected_revision is only for closeout and archive')
  for (const expected_revision of [0, -1, 1.5, Infinity, '2']) {
    expect(() => validateEmployeeLifecycleInput({ operation: 'begin_closeout', employee_id: employeeId, expected_revision })).toThrow('missing_employee_revision')
  }
  expect(() => validateEmployeeLifecycleInput({ operation: 'configure', employee_id: employeeId, expected_profile_revision: 1, role: 'Finance specialist' })).not.toThrow()
  expect(() => validateEmployeeLifecycleInput({ operation: 'begin_closeout', employee_id: employeeId, expected_revision: 2 })).not.toThrow()
  expect(() => validateEmployeeLifecycleInput({ operation: 'archive', employee_id: employeeId, expected_revision: 3 })).not.toThrow()
  expect(() => validateEmployeeLifecycleInput({ operation: 'inspect_closeout', employee_id: employeeId })).not.toThrow()
})
it('checks operation fields and creation replay identity without weakening server replay', () => {
  expect(() => validateEmployeeLifecycleInput({ operation: 'configure', employee_id: employeeId, expected_profile_revision: 1 })).toThrow('empty_employee_configuration')
  expect(() => validateEmployeeLifecycleInput({ operation: 'create', name: 'Finance' })).toThrow('invalid_creation_key')
  expect(() => validateEmployeeLifecycleInput({ operation: 'create', creation_key: 'new-finance', name: 'Finance', expected_revision: 1 })).toThrow('invalid_employee_creation')
  expect(() => validateEmployeeLifecycleInput({ operation: 'create', creation_key: 'new-finance', name: 'Finance', lifecycle: 'temporary' })).toThrow('future_deadline_required')
  // Core alone decides expiry for new creations; an exact retry of an already saved employee remains valid.
  expect(() => validateEmployeeLifecycleInput({ operation: 'create', creation_key: 'new-finance', name: 'Finance', lifecycle: 'temporary', expires_at: '2020-01-01T00:00:00Z' })).not.toThrow()
  expect(() => validateEmployeeLifecycleInput({ operation: 'create', creation_key: 'new-finance', name: 'Finance' })).not.toThrow()
})
it('retains Runtime authority and emits actionable recovery after real revision conflicts', async () => {
  const agent = { session: { header: { agentPreset: 'hivemind-hq' }, snapshotEvents: () => [{ type: 'hivemind/session-owner', data: { id: null, slug: 'runtime' } }] } }
  const args = { operation: 'begin_closeout' as const, employee_id: employeeId, expected_revision: 1 }
  const signal = new AbortController().signal
  const send = vi.fn().mockRejectedValue(new Error('lifecycle_revision_conflict'))
  const tool = employeeLifecycleTool(send)
  await expect(tool.execute(args, { agent, signal } as never)).rejects.toThrow('inspect_closeout')
  expect(send).toHaveBeenCalledWith(agent, args, signal)
  send.mockClear()
  await expect(tool.execute(args, { signal } as never)).rejects.toThrow('Only the persistent Runtime')
  expect(send).not.toHaveBeenCalled()
  expect(lifecycleErrorGuidance('employee_profile_revision_conflict')).toContain('Do not use expected_revision')
})
