import { describe, expect, it } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { runtimeStageGuidance } from '../src/stage-guidance.ts'
const input = (kind: string, fields: Record<string, unknown> = {}) => createUserMessage({ source: { kind, ...fields } as never, content: [{ type: 'text', text: 'Current input' }] })
const event = (type: string, data: unknown, seq = 2) => ({ type, data, seq }) as SessionEvent
const start = event('turn/start', { turn: 216 }, 1)
const stage = (messages: UserMessage[], events: SessionEvent[] = [start], awakening = false, nightly = false) => runtimeStageGuidance(events, messages, 'runtime', awakening, nightly)
describe('Runtime current-stage selection', () => {
  it('reconciles the exact authenticated administrator call before continuing existing work', () => {
    const actor = { userId:'owner',orgId:'company',role:'owner',name:'Owner' }
    const receipt = event('hivemind/voice-call-ended', { callId:'call-one',authenticatedActor:actor,
      interrupted:true,hadUserSpeech:true,transcript:'user: Existing customers first.' }, 0)
    const followup = input('plugin', { plugin:'hivemind-live-voice',voiceCallId:'call-one',authenticatedActor:actor })
    const text = stage([followup], [receipt,start])
    expect(text).toContain('Administrator call follow-up:')
    expect(text).toContain('preserve unanswered topics')
    expect(text).toContain('continue already authorized preparation, planning, delegation and review')
    expect(text).toContain('silence or assistant speech grants no new authority')
    expect(text).not.toContain('Recovery:')
    for (const fields of [
      { voiceCallId:'other-call',authenticatedActor:actor },
      { voiceCallId:'call-one',authenticatedActor:{ ...actor,orgId:'foreign' } },
      { voiceCallId:'call-one',authenticatedActor:{ ...actor,userId:'other' } },
      { voiceCallId:'call-one',authenticatedActor:{ ...actor,role:'member' } },
      { voiceCallId:'call-one' },
    ]) expect(stage([input('plugin', { plugin:'hivemind-live-voice',...fields })], [receipt,start]))
      .not.toContain('Administrator call follow-up:')
    expect(stage([followup])).not.toContain('Administrator call follow-up:')
    expect(stage([input('user')], [receipt,start])).not.toContain('Administrator call follow-up:')
  })
  it('orients once using existing agendas before agenda-dependent assignments', () => {
    const text = stage([input('user')], [start], true)
    expect(text).toContain('one concise agenda-setting exchange')
    expect(text).toContain('reversible provisional research')
    expect(text).toContain('Existing confirmed agendas do not require reconfirmation')
  })
  it('keeps ordinary user purpose, preparation and strategy iteration', () => {
    const text = stage([input('user')])
    expect(text).toContain('Human request:')
    expect(text).toContain('Prepare and inspect authorized concrete work')
    expect(text).toContain('reassess strategy only when evidence or priorities change')
    expect(text).not.toContain('Current Nightly report:')
  })
  it('does not activate the old nightly occurrence for Gmail turn216', () => {
    const old = input('schedule', { occurrenceAt: '2026-10-11T04:25:00Z' })
    const signal = input('hivemind-runtime-event', { eventId: 'current-gmail', action: 'wake' })
    const text = stage([signal], [event('user/message', old, 0), start])
    expect(text).toContain('Company signal:')
    expect(text).toContain('verify original author and scope')
    expect(text).toContain('Do not run a historical nightly review')
    expect(text).not.toContain('Current Nightly report:')
    expect(text).not.toContain('04:25')
  })
  it('resumes scheduled purpose without imposing a nightly workflow', () => {
    expect(stage([input('schedule', { occurrenceAt: '2026-10-11T05:00:00Z' })])).toContain('Scheduled work:')
  })
  it('inspects a current matching employee result and moves the next dependency', () => {
    const text = stage([input('hivemind-agent-message', { messageId: 'reply' })], [start,
      event('hivemind/room-message-received', { id: 'reply', targetId: 'runtime', kind: 'reply', taskId: 'task', artifactIds: ['artifact'] })])
    expect(text).toContain('Inspect the actual submitted artifact before acceptance')
    expect(text).toContain('Advance the next eligible dependency')
    expect(text).toContain('save a genuine input/access wait and email once')
  })
  it('does not adopt a foreign target receipt or copied message text as a result', () => {
    const text = stage([input('hivemind-agent-message', { messageId: 'reply' })], [start,
      event('hivemind/room-message-received', { id: 'reply', targetId: 'foreign', taskId: 'task', artifactIds: ['artifact'] })])
    expect(text).not.toContain('Employee result or blocker:')
    expect(text).toContain('Recovery:')
  })
  it('keeps colleague greetings out of human approval and task creation', () => {
    const text = stage([input('hivemind-agent-message', { messageId: 'hello' })], [start,
      event('hivemind/room-message-received', { id: 'hello', targetId: 'runtime', kind: 'question', artifactIds: [] })])
    expect(text).toContain('A greeting or closed reply does not require investigation')
  })
  it('requires native call correlation and server answer identity', () => {
    const answer = input('user-question-reply', { callId: 'call', outcome: 'answered', questionAnswerSubmission: true, authenticatedActor: { userId: 'admin' } })
    expect(stage([answer])).not.toContain('Answered decision:')
    expect(stage([answer], [start, event('tool/call', { callId: 'call' })])).toContain('Answered decision:')
    expect(stage([input('user-question-reply', { callId: 'call', outcome: 'answered' })], [start, event('tool/call', { callId: 'call' })])).not.toContain('Answered decision:')
  })
  it('only current native ready receipt activates access continuation', () => {
    expect(stage([], [event('hivemind/connected-receipt', { receipt: { status: 'ready' } }, 0), start])).not.toContain('Access continuation:')
    expect(stage([], [start, event('hivemind/connected-receipt', { receipt: { status: 'ready' } })])).toContain('Access continuation:')
  })
  it('collects nightly replies and sends a normal report without business task or artifact', () => {
    const text = stage([input('schedule')], [start], false, true)
    expect(text).toContain('Current Nightly report:')
    expect(text).toContain('request detailed findings once')
    expect(text).toContain('ordinary detailed email')
    expect(text).toContain('no business task or separate HTML artifact')
    expect(text).not.toContain('Scheduled work:')
  })
  it('preserves all mixed current source obligations once within a bounded briefing', () => {
    const text = stage([input('user'), input('user'), input('hivemind-runtime-event')])
    expect(text.match(/Human request:/g)).toHaveLength(1)
    expect(text).toContain('Company signal:')
    expect(text.length).toBeLessThan(2400)
  })
})

it('keeps native direct Inbox and historical mailbox source identities distinct from human authority', () => {
  const member = event('team/member', { teamId:'runtime',member:{ id:'analyst',phase:'active' } })
  expect(stage([input('agent-message', { senderSessionId:'analyst',form:'relay' })], [start,member])).toContain('Native Inbox colleague exchange:')
  expect(stage([input('agent-message', { senderSessionId:'foreign',form:'relay' })], [start,member])).not.toContain('Native Inbox colleague exchange:')
  expect(stage([input('agent-message', { senderSessionId:'analyst',form:'relay' })], [start,member,event('team/member',{ teamId:'runtime',member:{ id:'analyst',phase:'archived' } },3)])).not.toContain('Native Inbox colleague exchange:')
  const message={ id:'mail',senderId:'analyst',targetId:'runtime' }
  expect(stage([input('team-message',{ teamId:'runtime',messageId:'mail',senderId:'analyst' })],[start,event('team/message/queued',{ message })])).toContain('Native Team exchange:')
})
