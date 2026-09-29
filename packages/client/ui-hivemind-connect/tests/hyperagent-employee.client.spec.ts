import { describe, expect, it } from 'vitest'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { employeeMenuHeight, isHyperagentPreset, selectedEmployee } from '../src/client/HyperagentEmployee.tsx'
import { workbenchSnapshot } from '../src/client/HyperagentWorkbench.tsx'

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

  it('projects only durable artifact, capture and research receipts', () => {
    const window = { entries: [
      { type: 'event', event: { type: 'hivemind/artifact-created', data: { artifactId: 'a1', title: 'Report', path: '/work/report.pdf', mediaType: 'application/pdf', preview: { attachmentId: 'p1', mediaType: 'image/png' } } } },
      { type: 'event', event: { type: 'hivemind/browser-capture', data: { captureId: 'b1', title: 'Home', url: 'https://example.com', status: 200 } } },
      { type: 'event', event: { type: 'hivemind/research-receipt', data: { sources: [{ url: 'https://example.com', title: 'Source' }, { url: 'https://example.com', title: 'Duplicate' }] } } },
    ] } as unknown as SessionEventWindow
    const result = workbenchSnapshot(window)
    expect(result.artifacts.map(item => item.title)).toEqual(['Report'])
    expect(result.captures.map(item => item.title)).toEqual(['Home'])
    expect(result.sources).toEqual([{ url: 'https://example.com', title: 'Source' }])
  })
})
