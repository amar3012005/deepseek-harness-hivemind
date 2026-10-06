import { expect, it, vi } from 'vitest'
import { validateEmployeeProfileFields, lifecycleBusinessError, employeeLifecycleTool } from '../src/employee-lifecycle.ts'
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
