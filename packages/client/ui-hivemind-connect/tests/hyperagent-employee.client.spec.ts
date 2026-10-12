import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { employeeAppearance, employeeMenuHeight, employeeOwnershipLocked, isHyperagentPreset, projectedEmployee, selectedEmployee } from '../src/client/HyperagentEmployee.tsx'
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

  it('reads the owner projection independently of the paginated event log', () => {
    expect(projectedEmployee(JSON.stringify({ id: 'elena', name: 'Elena', role: 'strategist' }))?.name).toBe('Elena')
    expect(projectedEmployee(JSON.stringify({ id: null, name: 'HyperAgents', role: 'Team Lead' }))).toBeNull()
  })

  it('bounds downward roster by remaining viewport', () => {
    expect(employeeMenuHeight(720, 480)).toBe(224)
    expect(employeeMenuHeight(1000, 300)).toBe(360)
  })

  it('projects only durable artifact, capture and research receipts', () => {
    const window = { entries: [
      { type: 'event', event: { type: 'hivemind/artifact-created', data: { artifactId: 'a1', title: 'Report', path: 'report.pdf', mediaType: 'application/pdf', pdf: { attachmentId: 'f1', name: 'report.pdf', bytes: 4 }, preview: { attachmentId: 'p1', mediaType: 'image/png' } } } },
      { type: 'event', event: { type: 'hivemind/browser-capture', data: { captureId: 'b1', title: 'Home', url: 'https://example.com', status: 200 } } },
      { type: 'event', event: { type: 'hivemind/research-receipt', seq: SessionSeq(2), data: { sources: [{ url: 'https://example.com/', title: 'Source' }, { url: 'https://example.com/', title: 'Duplicate' }] } } },
    ] } as unknown as SessionEventWindow
    const result = workbenchSnapshot(window)
    expect(result.artifacts.map(item => item.title)).toEqual(['Report'])
    expect(result.artifacts[0]?.file).toMatchObject({ attachmentId: 'f1', name: 'report.pdf' })
    expect(result.captures.map(item => item.title)).toEqual(['Home'])
    expect(result.sources).toEqual([{ url: 'https://example.com/', title: 'Duplicate', seq: SessionSeq(2), visited: false }])
  })
})


describe('returned employee artifacts', () => {
  it('projects a delivered file with producer attribution without claiming Runtime generated it', () => {
    const file = { attachmentId: 'saved-file', name: 'brief.pdf', bytes: 42 }
    const window = { entries: [{ type: 'event', event: { type: 'hivemind/room-message-received', data: {
      senderName: 'Ravi', artifacts: [{ artifactId: 'receipt-1', title: 'Cafe brief', mediaType: 'application/pdf',
        file, producerSessionId: 'ravi-room' }],
    } } }] } as unknown as SessionEventWindow
    expect(workbenchSnapshot(window).artifacts).toEqual([{ id: 'receipt-1', title: 'Cafe brief',
      path: 'brief.pdf', mediaType: 'application/pdf', file, preview: undefined, producerName: 'Ravi' }])
  })

  it('ignores files without a producer receipt reference', () => {
    const window = { entries: [{ type: 'event', event: { type: 'hivemind/room-message-received', data: {
      artifacts: [{ artifactId: 'unknown', file: { attachmentId: 'f', name: 'brief.pdf', bytes: 42 } }],
    } } }] } as unknown as SessionEventWindow
    expect(workbenchSnapshot(window).artifacts).toEqual([])
  })
})

describe('saved Humation appearance', () => {
  const appearance = { version:1,provider:'humation',template:'humation-1',asset_version:'1.0.1',seed:'saved',
    selections:{ head:'hm1-p-000001',body:'hm1-p-000025',bottom:'hm1-p-000033',item:'hm1-p-000041',glasses:'hm1-p-000056' },
    colors:{ stroke:'000000',hair:'000000',skin:'FFFFFF',clothes:'FFFFFF',bottom:'000000' },background:'transparent',crop:'avatar' }
  it('retains canonical customization on a cold persisted owner', () => {
    expect(projectedEmployee(JSON.stringify({ id:'saved',name:'Alex',role:'Specialist',appearance }))?.appearance)
      .toEqual(employeeAppearance(appearance))
    expect(employeeAppearance(appearance)?.selections['item']).toBe('hm1-p-000041')
  })
  it('rejects cross-slot and unsupported asset metadata without changing legacy defaults', () => {
    expect(employeeAppearance({ ...appearance,selections:{ ...appearance.selections,head:'hm1-p-000025' } })).toBeUndefined()
    expect(employeeAppearance({ ...appearance,asset_version:'unknown' })).toBeUndefined()
    expect(projectedEmployee(JSON.stringify({ id:'legacy',name:'Legacy',role:'Researcher' }))?.appearance).toBeUndefined()
  })
})
