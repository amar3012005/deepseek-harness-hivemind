import { describe, expect, it } from 'vitest'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { employeeMenuHeight, employeeOwnershipLocked, isHyperagentPreset, selectedEmployee } from '../src/client/HyperagentEmployee.tsx'
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

  it('keeps the persisted owner visible and locks selection after the first turn', () => {
    const window = { entries: [{ type: 'event', event: { type: 'hivemind/session-owner', data: { id: 'elena', name: 'Elena', role: 'strategist' } } }, ...events({ id: 'ravi', name: 'Ravi', role: 'researcher' }).entries] } as unknown as SessionEventWindow
    expect(selectedEmployee(window)?.name).toBe('Elena')
    expect(employeeOwnershipLocked(window)).toBe(true)
    expect(employeeOwnershipLocked(events())).toBe(false)
    expect(employeeOwnershipLocked({ entries: [{ type: 'event', event: { type: 'turn/start', data: { turn: 1 } } }] } as never)).toBe(true)
  })

  it('bounds downward roster by remaining viewport', () => {
    expect(employeeMenuHeight(720, 480)).toBe(224)
    expect(employeeMenuHeight(1000, 300)).toBe(360)
  })

  it('projects only durable artifact, capture and research receipts', () => {
    const window = { entries: [
      { type: 'event', event: { type: 'hivemind/artifact-created', data: { artifactId: 'a1', title: 'Report', path: 'report.pdf', mediaType: 'application/pdf', pdf: { attachmentId: 'f1', name: 'report.pdf', bytes: 4 }, preview: { attachmentId: 'p1', mediaType: 'image/png' } } } },
      { type: 'event', event: { type: 'hivemind/browser-capture', data: { captureId: 'b1', title: 'Home', url: 'https://example.com', status: 200 } } },
      { type: 'event', event: { type: 'hivemind/research-receipt', data: { sources: [{ url: 'https://example.com', title: 'Source' }, { url: 'https://example.com', title: 'Duplicate' }] } } },
    ] } as unknown as SessionEventWindow
    const result = workbenchSnapshot(window)
    expect(result.artifacts.map(item => item.title)).toEqual(['Report'])
    expect(result.artifacts[0]?.file).toMatchObject({ attachmentId: 'f1', name: 'report.pdf' })
    expect(result.captures.map(item => item.title)).toEqual(['Home'])
    expect(result.sources).toEqual([{ url: 'https://example.com', title: 'Source' }])
  })
})
