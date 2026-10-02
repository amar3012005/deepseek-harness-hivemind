import { describe, expect, it } from 'vitest'
import { wakeBriefing } from '../src/wake-briefing.ts'
import type { HqWorkspace } from '../src/types.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
const workspace: HqWorkspace = { mode: { enabled: false, revision: 0, changedAt: 0 }, tasks: [], calendar: [], wakes: [] }
describe('HQ wake briefing', () => {
  it('preserves pause, native wake delivery and task evidence without inferring completion', () => {
    const text = wakeBriefing({ ...workspace, wakes: [{ id: 'wake-1', title: 'Review', kind: 'once', scheduledAt: '2030-01-01', status: 'completed', deliveredAt: '2030-01-01' }] }, [], 'root')
    expect(text).toContain('"enabled":false')
    expect(text).toContain('"deliveredAt":"2030-01-01"')
    expect(text).toContain('do not certify task completion')
    expect(text).toContain('When nothing is due, remain quiet')
  })
  it('includes quiet persistent employee notices with exact artifact references', () => {
    const events = [{ type: 'hivemind/room-message-received', data: { id: 'notice', senderName: 'Ravi', kind: 'update', text: 'Saved report', artifactIds: ['artifact-1'] } }] as unknown as SessionEvent[]
    const text = wakeBriefing(workspace, events, 'root')
    expect(text).toContain('"kind":"update"')
    expect(text).toContain('"artifactIds":["artifact-1"]')
  })
  it('retains only messages addressed to this root and bounds message history', () => {
    const events = Array.from({ length: 20 }, (_, id) => ({ type: 'team/message/queued', data: { message: { id: String(id), targetId: id === 19 ? 'other' : 'root', senderName: 'Ravi', content: [{ type: 'text', text: 'question' }] } } })) as unknown as SessionEvent[]
    const text = wakeBriefing(workspace, events, 'root')
    const result = JSON.parse(text.slice(text.indexOf('{')))
    expect(result.employeeMessages).toHaveLength(12)
    expect(result.employeeMessages.at(-1).id).toBe('18')
  })
})
