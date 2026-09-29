import { describe, expect, it } from 'vitest'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { employeeMenuHeight, isHyperagentPreset, selectedEmployee } from '../src/client/HyperagentEmployee.tsx'

function events(...rows: Array<{ id: string | null; name?: string; role?: string }>): SessionEventWindow {
  return { entries: rows.map(data => ({ type: 'event', event: { type: 'hivemind/employee-selection', data } })) } as unknown as SessionEventWindow
}

describe('HyperAgents employee selection', () => {
  it('stays scoped to HyperAgents modes', () => {
    expect(isHyperagentPreset('hivemind-hyperagents')).toBe(true)
    expect(isHyperagentPreset('hivemind-chat')).toBe(false)
    expect(isHyperagentPreset('standard')).toBe(false)
  })

  it('projects latest durable selection and auto reset', () => {
    expect(selectedEmployee(events({ id: '1', name: 'Ravi', role: 'researcher' }))).toEqual({ id: '1', name: 'Ravi', role: 'researcher' })
    expect(selectedEmployee(events({ id: '1', name: 'Ravi', role: 'researcher' }, { id: null }))).toBeNull()
  })

  it('bounds downward roster by remaining viewport', () => {
    expect(employeeMenuHeight(720, 480)).toBe(224)
    expect(employeeMenuHeight(1000, 300)).toBe(360)
  })
})
