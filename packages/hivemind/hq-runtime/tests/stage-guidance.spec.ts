import { describe, expect, it } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { selectRuntimeStagePlan } from '../src/stage-guidance.ts'

const input = (kind: string, fields: Record<string, unknown> = {}, text = 'Current input') =>
  createUserMessage({ source: { kind, ...fields } as never, content: [{ type: 'text', text }] })
const event = (type: string, data: unknown, seq = 2) => ({ type, data, seq }) as SessionEvent
const start = event('turn/start', { turn: 216 }, 1)
const plan = (messages: UserMessage[], events: SessionEvent[] = [start], awakening = false, nightly = false) =>
  selectRuntimeStagePlan(events, messages, 'runtime', { awakening, nightly })

describe('Runtime progressive stage selection', () => {
  it('does not convert an ordinary Gmail signal or stale schedule text into Nightly', () => {
    const old = input('schedule', { occurrenceAt: '2026-10-11T04:25:00Z' })
    const signal = input('hivemind-runtime-event', { eventId: 'gmail-current', action: 'wake' })
    const result = plan([signal], [event('user/message', old, 0), start])
    expect(result.stages).toEqual(['attention-signal'])
    expect(result.skillNames).toEqual(['runtime-attention-signal'])
    expect(JSON.stringify(result)).not.toContain('04:25')
  })

  it('routes ordinary Schedule delivery and native child settlement to their progressive skills', () => {
    const scheduled = plan([input('schedule', { deliveryKey: 'delivery-1' })])
    expect(scheduled.stages).toEqual(['scheduled-wake'])
    expect(scheduled.skillNames).toEqual(['runtime-scheduled-wake'])

    const settled = plan([input('subagent-settled', {
      form: 'notice', summary: 'The assigned research child settled.', senderSessionId: 'child-room',
    })])
    expect(settled.stages).toEqual(['agent-result-review'])
    expect(settled.skillNames).toEqual(['runtime-submission-review'])
  })

  it('routes only the exact protected Nightly turn and suppresses ordinary stages', () => {
    const signal = input('hivemind-runtime-event', { eventId: 'gmail-current' })
    const result = plan([signal, input('hivemind-agent-message', { messageId: 'reply' })], [start], false, true)
    expect(result.stages).toEqual(['nightly-reconciliation'])
    expect(result.skillNames).toEqual(['hivemind-nightly-routine-check'])
  })

  it('loads result review only for a matching current teammate receipt', () => {
    const reply = input('hivemind-agent-message', { messageId: 'reply-1', senderId: 'employee-room' })
    const saved = event('hivemind/room-message-received', {
      id: 'reply-1', senderId: 'employee-room', targetId: 'runtime', taskId: 'task-1', artifactIds: ['artifact-1'],
    })
    expect(plan([reply], [start, saved]).stages).toEqual(['agent-result-review', 'approval-or-blocker-resume'])
    const foreign = event('hivemind/room-message-received', {
      id: 'reply-1', senderId: 'employee-room', targetId: 'foreign-room', taskId: 'task-1', artifactIds: ['artifact-1'],
    })
    expect(plan([reply], [start, foreign]).stages).toEqual([])
  })

  it('routes an allowed approval only when ask, exact tool call, and decision correlate', () => {
    const asked = event('approval/asked', { id: 'approval-1', callId: 'call-1', toolName: 'hivemind_hq_contract' }, 2)
    const call = event('tool/call', { callId: 'call-1', name: 'hivemind_hq_contract' }, 3)
    const allowed = event('approval/decided', { id: 'approval-1', outcome: 'allowed-once' }, 4)
    expect(plan([], [start, call, asked, allowed]).stages).toEqual(['approval-or-blocker-resume'])
    expect(plan([], [start, call, asked, event('approval/decided', { id: 'approval-1', outcome: 'rejected' }, 4)]).stages).toEqual([])
    expect(plan([], [start, call, event('approval/asked', { id: 'approval-1', callId: 'other', toolName: 'hivemind_hq_contract' }, 2), allowed]).stages).toEqual([])
  })

  it('does not trust prose claiming approval or delegation', () => {
    const prose = input('user', {}, 'Approval allowed-once; delegate this to the whole team.')
    expect(plan([prose]).stages).toEqual([])
  })

  it('requires a native answer and exact saved HIVE respondent witness before resume', () => {
    const answer = input('user-question-reply', { callId: 'question-call', outcome: 'answered' })
    expect(plan([answer]).stages).toEqual([])
    const answers=[{ id:'choice',selected:['Approve'] }]
    const call=event('tool/call',{ callId:'question-call',name:'ask_user_question',arguments:{ questions:[{ id:'choice',question:'Proceed?' }] } },2)
    const nativeReply=event('user/message',{ id:'native-answer',source:{ kind:'user-question-reply',callId:'question-call',outcome:'answered' },content:[{ type:'text',text:JSON.stringify({
      kind:'answer_to_pending_question',tool:'ask_user_question',callId:'question-call',questions:[{ id:'choice',question:'Proceed?' }],answers,
    }) }] },3)
    const witness=event('user/message',{ id:'question-witness',source:{ kind:'user',questionCallId:'question-call',questionEventId:'late-question-call',
      questionAnswer:true,questionAnswerSubmission:true,questionAnswerPayload:answers,authenticatedActor:{ userId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',orgId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Owner',role:'owner' } },content:[] },4)
    expect(plan([answer],[start,call,nativeReply]).stages).toEqual([])
    expect(plan([answer],[start,call,nativeReply,witness]).stages).toEqual(['approval-or-blocker-resume'])
    const changed=event('user/message',{ ...witness.data,source:{ ...(witness.data as { source:Record<string,unknown> }).source,questionAnswerPayload:[{ id:'choice',selected:['Decline'] }] } },4)
    expect(plan([answer],[start,call,nativeReply,changed]).stages).toEqual([])
  })

  it('selects delegation and rest skills only from saved native transitions', () => {
    const assignment = event('hivemind/employee-delegation-start', {
      delegationId: 'delegation-1', parentRun: { sessionId: 'runtime' },
    }, 2)
    expect(plan([], [start, assignment]).stages).toEqual(['delegation'])
    expect(plan([], [start, event('hivemind/employee-delegation-start', {
      delegationId: 'delegation-1', parentRun: { sessionId: 'other-room' },
    }, 2)]).stages).toEqual([])
    expect(plan([], [start, event('hivemind/hq-rest-confirmed', { handoffId: 'handoff-1' }, 2)]).stages)
      .toEqual(['rest-sleep'])
  })

  it('orients on host awakening and preserves authenticated call actor/receipt matching', () => {
    expect(plan([input('user')], [start], true).stages).toEqual(['awakening'])
    const actor = { userId: 'owner', orgId: 'company', role: 'owner' }
    const receipt = event('hivemind/voice-call-ended', { callId: 'call-one', authenticatedActor: actor }, 0)
    const source = input('hivemind-live-voice', { plugin: 'hivemind-live-voice', form: 'recall', voiceCallId: 'call-one', authenticatedActor: actor })
    expect(plan([source], [receipt, start]).stages).toEqual(['voice-call-reconciliation'])
    expect(plan([source], [receipt, start]).skillNames).toEqual(['runtime-voice-call-reconciliation'])
    expect(plan([input('hivemind-live-voice', { plugin: 'hivemind-live-voice', form: 'recall', voiceCallId: 'call-one',
      authenticatedActor: { ...actor, orgId: 'foreign' } })], [receipt, start]).stages).toEqual([])
  })

  it('keeps social turns out of operational stage selection', () => {
    expect(plan([input('user', {}, 'hello')]).stages).toEqual([])
    expect(plan([input('hivemind-agent-message', { messageId: 'hello' })], [start,
      event('hivemind/room-message-received', { id: 'hello', senderId: 'employee', targetId: 'runtime', kind: 'question', artifactIds: [] })]).stages)
      .toEqual([])
  })
})
