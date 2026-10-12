import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, foldSurface } from '@deepseek-ai/dsh-session'
import { foldUserQuestions } from '@deepseek-ai/dsh-user-questions/src/projection.ts'
import { completedExchanges, recentConversationText, contextPlugin } from '../src/index.ts'

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function mount(
  events: unknown[] = [],
  profileBrief?: (agent: Agent, signal: AbortSignal, turn: number) => Promise<string | undefined>,
  turnInstruction?: (agent: Agent, turn: number) => string | undefined,
  pendingCalls: string[] = [],
  nativePending = false,
) {
  let preStep: ((payload: never, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const ctx = {
    get: () => ({ snapshot: (session: Session) => ({ values: { userQuestions: nativePending
      ? foldUserQuestions(session.snapshotEvents()) : { active: pendingCalls.map(callId => ({ callId })) } } }) }),
    effect(callback: () => (() => void) | undefined) {
      return callback()
    },
    on(event: string, listener: typeof preStep) {
      if (event === 'agent/pre-step') preStep = listener
      return () => {}
    },
  }
  contextPlugin({
    historyTurns: 3,
    historyMaxChars: 3_000,
    capabilityToolName: 'hivemind_capabilities',
    ...(profileBrief === undefined ? {} : { profileBrief }),
    ...(turnInstruction === undefined ? {} : { turnInstruction }),
  }).apply(ctx as never)
  const agent = {
    session: {
      surface: { nodes: [] },
      eventAt: (seq: number) => events.find(event => (event as { seq?: number }).seq === seq),
      snapshotEvents: () => events,
    },
  }
  return { agent, preStep: preStep! }
}

describe('HIVE progressive context', () => {
  it('bounds injected recall while preserving the complete saved input and exact current request', async () => {
    const session = Session.create(SessionId('bounded-injected-recall'))
    const harness = mount()
    const agent = { session }
    const request = user('Read the saved task record, not the old roster request')
    const recall = createUserMessage({
      source: { kind: 'plugin', plugin: 'hivemind-hq/wake-briefing', form: 'recall' },
      content: [{ type: 'text', text: 'old task evidence '.repeat(50_000) }],
    })
    const decision = await harness.preStep({ agent, turn: 1, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: [recall, request] })) as { messages: ReturnType<typeof user>[] }
    expect(decision.messages).toEqual([request])
    expect(session.snapshotEvents().some(event => event.type === 'user/message' && event.data.content[0]
      && JSON.stringify(event.data.content) === JSON.stringify(recall.content))).toBe(true)
    for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
    const visible = session.deriveMessages()
    expect(visible.at(-1)).toEqual(request)
    expect(JSON.stringify(visible).length).toBeLessThan(4500)
    const restored = Session.create(SessionId('bounded-injected-recall-restored'), session.snapshotEvents())
    expect(restored.deriveMessages()).toEqual(visible)
  })

  it('retains persistent ownership instructions alongside the initial company brief', async () => {
    const harness = mount([], async () => 'Company brief', () => 'You are Elena, persistent owner')
    const result = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({ kind: 'enter' as const, messages: [user('Create blueprint')] })) as { messages: ReturnType<typeof user>[] }
    const text = result.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    expect(text).toContain('Company brief')
    expect(text).toContain('You are Elena, persistent owner')
  })

  it('re-reads the authoritative turn instruction on every new turn', async () => {
    let language = 'en'
    const harness = mount([], undefined, () => `Reply language: ${language}`)
    const run = async (turn: number, text: string) => await harness.preStep({
      agent: harness.agent, turn, signal: new AbortController().signal,
    } as never, async () => ({ kind: 'enter' as const, messages: [user(text)] })) as { messages: ReturnType<typeof user>[] }
    const first = await run(1, 'hello')
    language = 'de'
    const second = await run(2, 'hello again')
    const texts = (messages: ReturnType<typeof user>[]) => messages.map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    expect(texts(first.messages)).toEqual(['Reply language: en', 'hello'])
    expect(texts(second.messages)).toEqual(['Reply language: de', 'hello again'])
  })

  it('replaces completed tool history without requiring a profile anchor and leaves current work intact', async () => {
    const harness = mount()
    const events = [
      { type: 'system/message', seq: 0 },
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, surfaceOp: 'append', data: user('Find the latest item') },
      { type: 'tool/result', seq: 3, surfaceOp: 'append', data: { turn: 1, message: createToolResultMessage({
        callId: 'one' as never, content: [{ type: 'text', text: 'LARGE_OLD_TOOL_RECEIPT' }], isError: false,
      }) } },
      { type: 'assistant/message', seq: 4, surfaceOp: 'append', data: { turn: 1, message: createAssistantMessage({
        source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'The latest item is ready.' }],
      }) } },
      { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 6, data: { turn: 2 } },
      { type: 'user/message', seq: 7, surfaceOp: 'append', data: user('Current work already admitted') },
    ]
    const append = vi.fn()
    const agent = { session: { surface: { nodes: [0, 2, 3, 4, 7] }, snapshotEvents: () => events,
      eventAt: (seq: number) => events.find(event => event.seq === seq), append,
    } }
    const decision = await harness.preStep({ agent, turn: 2, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: [user('Next question')] })) as { startsRequestSeries?: boolean }
    expect(decision.startsRequestSeries).toBe(true)
    expect(append.mock.calls[0]?.[2]).toEqual({ surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 }, sourceEventSeqs: [2, 3, 4] })
    const text = JSON.stringify(append.mock.calls[0]?.[1])
    expect(text).toContain('Find the latest item')
    expect(text).toContain('The latest item is ready.')
    expect(text).not.toContain('LARGE_OLD_TOOL_RECEIPT')
    expect(text).not.toContain('Current work already admitted')
    expect(events).toHaveLength(8)
  })
  it('uses complete positional provenance after pruning and compaction, including cold replay', async () => {
    const session = Session.create(SessionId('history-replacements'))
    session.append('turn/start', { turn: 1 })
    const request = session.append('user/message', user('Review the company evidence'), { surfaceOp: 'append' })
    const assistant = session.append('assistant/message', {
      turn: 1, step: 1, stream: [], message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [{ type: 'tool-call', id: 'old' as never, name: 'read', arguments: '{}'  }],
      }),
    }, { surfaceOp: 'append' })
    const oldResult = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId: 'old' as never, content: [{ type: 'text', text: 'OLD_EVIDENCE' }], isError: false,
    }) }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 2, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Evidence reviewed.' }],
    }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const current = session.append('user/message', user('Continue this exact task'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 2, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: 'current' as never, name: 'read', arguments: '{}'  }],
    }) }, { surfaceOp: 'append' })
    const currentResult = session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({
      callId: 'current' as never, content: [{ type: 'text', text: 'CURRENT_EVIDENCE' }], isError: false,
    }) }, { surfaceOp: 'append' })
    const pruned = session.append('tool/result', { ...oldResult.data, message: {
      ...oldResult.data.message,
      content: [{ ...oldResult.data.message.content[0], content: [{ type: 'text', text: 'PRUNED_EVIDENCE' }] }],
    } }, { surfaceOp: { op: 'replace', startSeq: oldResult.seq, endSeq: oldResult.seq }, sourceEventSeqs: [oldResult.seq] })
    const compact = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Earlier decisions retained' }], source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: { op: 'replace', startSeq: request.seq, endSeq: request.seq }, sourceEventSeqs: [request.seq] })
    const before = session.snapshotEvents()
    const harness = mount()
    await expect(harness.preStep({ agent: { session }, turn: 2, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: session.deriveMessages() }))).resolves.toMatchObject({ startsRequestSeries: true })
    const projection = session.snapshotEvents().at(-1)!
    expect(projection.sourceEventSeqs).toContain(pruned.seq)
    expect(projection.sourceEventSeqs).not.toContain(compact.seq)
    expect(session.surface.nodes).toContain(compact.seq)
    expect(projection.sourceEventSeqs).toContain(assistant.seq)
    expect(projection.sourceEventSeqs).not.toContain(current.seq)
    expect(session.snapshotEvents().slice(0, before.length)).toEqual(before)
    const restored = Session.create(SessionId('history-restored'), session.snapshotEvents())
    expect(restored.surface.nodes).toEqual(session.surface.nodes)
    expect(foldSurface(restored.snapshotEvents()).nodes).toEqual(session.surface.nodes)
    expect(restored.deriveMessages()).toContainEqual(current.data)
    expect(restored.deriveMessages().at(-1)).toEqual(currentResult.data.message)
    const blocks = restored.deriveMessages().flatMap(message => message.content)
    expect(blocks.filter(block => block.type === 'tool-call').map(block => block.id)).toEqual(['current'])
    expect(blocks.filter(block => block.type === 'tool-result').map(block => block.toolCallId)).toEqual(['current'])
  })

  it('keeps a native working checkpoint and does not rewrite an unchanged recent window', async () => {
    const session = Session.create(SessionId('working-window'))
    session.append('turn/start', { turn: 1 })
    const old = session.append('user/message', user('Deliver the agreed plan'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'The plan is agreed.' }],
    }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const checkpoint = session.append('user/message', createUserMessage({
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'native-checkpoint' as never },
      content: [{ type: 'text', text: 'Pending approval and current task checkpoint' }],
    }), { surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq }, sourceEventSeqs: [old.seq] })
    const current = session.append('user/message', user('Continue'), { surfaceOp: 'append' })
    const agent = { session }
    const harness = mount()
    await harness.preStep({ agent, turn: 2, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: session.deriveMessages() }))
    expect(session.surface.nodes).toContain(checkpoint.seq)
    const before = session.snapshotEvents()
    const decision = await harness.preStep({ agent, turn: 3, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: session.deriveMessages() })) as { startsRequestSeries?: boolean }
    expect(decision.startsRequestSeries).toBeUndefined()
    expect(session.snapshotEvents()).toEqual(before)
    expect(session.deriveMessages()).toContainEqual(checkpoint.data)
    expect(session.deriveMessages().at(-1)).toEqual(current.data)
  })

  it('retains an unanswered native call and matching result instead of hiding its pending work', async () => {
    const session = Session.create(SessionId('pending-window'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', user('Prepare the research'), { surfaceOp: 'append' })
    const question = session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: 'pending-question' as never, name: 'ask_user_question', arguments: '{}' }],
    }) }, { surfaceOp: 'append' })
    const pending = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId: 'pending-question' as never, content: [{ type: 'text', text: 'Pending authenticated answer' }], isError: false,
    }) }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 2, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'I am waiting for that answer.' }],
    }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('user/message', user('Another request'), { surfaceOp: 'append' })
    const harness = mount([], undefined, undefined, ['pending-question'])
    await harness.preStep({ agent: { session }, turn: 2, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: session.deriveMessages() }))
    expect(session.surface.nodes).toContain(question.seq)
    expect(session.surface.nodes).toContain(pending.seq)
    const restored = Session.create(SessionId('pending-restored'), session.snapshotEvents())
    expect(restored.deriveMessages().flatMap(message => message.content).filter(block => block.type === 'tool-call')).toHaveLength(1)
    expect(restored.deriveMessages().flatMap(message => message.content).filter(block => block.type === 'tool-result')).toHaveLength(1)
  })

  it('keeps the original Team wait source and full tool pair through cold restoration', async () => {
    const session = Session.create(SessionId('team-working-window'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', user('Earlier request'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Earlier result' }],
    }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const original = session.append('user/message', user('Collect the nightly employee reports'), { surfaceOp: 'append' })
    const call = session.append('assistant/message', { turn: 2, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: 'team-wait' as never, name: 'wait', arguments: '{}' }],
    }) }, { surfaceOp: 'append' })
    const result = session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({
      callId: 'team-wait' as never, content: [{ type: 'text', text: 'Waiting for Elena' }], isError: false,
    }) }, { surfaceOp: 'append' })
    session.append('team/wait/parked', {
      callId: 'team-wait' as never, teamId: 'this-team', expectedSenderIds: ['elena'], originalSourceMessageId: original.data.id,
    })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const before = session.snapshotEvents()
    const harness = mount()
    await harness.preStep({ agent: { session }, turn: 3, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: session.deriveMessages() }))
    expect(session.snapshotEvents().slice(0, before.length)).toEqual(before)
    const restored = Session.create(SessionId('team-window-restored'), session.snapshotEvents())
    for (const event of [original, call, result]) expect(restored.surface.nodes).toContain(event.seq)
    expect(restored.deriveMessages().flatMap(message => message.content).filter(block => block.type === 'tool-call')).toHaveLength(1)
    expect(restored.deriveMessages().flatMap(message => message.content).filter(block => block.type === 'tool-result')).toHaveLength(1)
  })

  it('projects only successful exchanges and leaves failed work available for recovery', async () => {
    const session = Session.create(SessionId('failed-window'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', user('Successful request'), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Successful answer' }],
    }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const failed = session.append('user/message', user('Failed request needs recovery'), { surfaceOp: 'append' })
    const partial = session.append('assistant/message', { turn: 2, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Partial result, not completed' }],
    }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'provider failed' } } })
    const harness = mount()
    await harness.preStep({ agent: { session }, turn: 3, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: session.deriveMessages() }))
    expect(completedExchanges(session.snapshotEvents())).toHaveLength(1)
    expect(session.surface.nodes).toContain(failed.seq)
    expect(session.surface.nodes).toContain(partial.seq)
    const recent = recentConversationText(Array.from({ length: 30 }, (_, turn) => ({
      turn, user: `request-${turn}`, assistant: `answer-${turn}`,
    })), 15, 16_000)
    expect(recent).not.toContain('request-14')
    expect(recent).toContain('request-15')
    expect(recent).toContain('request-29')
    expect(recent.length).toBeLessThanOrEqual(16_000)
    expect(recent).toContain('END OF SAVED CONVERSATION RECORDS.')
    const huge = recentConversationText([{ turn: 99, user: 'quoted request'.repeat(1000), assistant: 'old answer' }], 15, 600)
    expect(huge.length).toBeLessThanOrEqual(600)
    expect(huge).toContain('END OF SAVED CONVERSATION RECORDS.')
    expect(huge).toContain('pastTurn')
  })

  it('keeps a real pending approval from the native projection after denied tool output and cold replay', async () => {
    const session = Session.create(SessionId('approval-window'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', user('Prepare the release'), { surfaceOp: 'append' })
    const call = session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'fixture', model: 'fixture' },
      content: [{ type: 'tool-call', id: 'approval-call' as never, name: 'publish_release', arguments: JSON.stringify({ revision: 'approved-source' }) }],
    }) }, { surfaceOp: 'append' })
    session.append('approval/asked', { id: 'approval-id', callId: 'approval-call', toolName: 'publish_release',
      questions: [{ id: 'approval', question: 'Allow this release?', options: [{ label: 'Allow once' }, { label: 'Reject' }] }],
    } as never)
    session.append('approval/decided', { id: 'approval-id', outcome: 'pending' } as never)
    const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId: 'approval-call' as never, content: [{ type: 'text', text: 'Waiting for authenticated approval' }], isError: true,
    }) }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 2, stream: [], message: createAssistantMessage({
      source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'Release is paused.' }],
    }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const restored = Session.create(SessionId('approval-cold'), session.snapshotEvents())
    expect(foldUserQuestions(restored.snapshotEvents()).active).toMatchObject([{ callId: 'approval-call', state: 'continued' }])
    const harness = mount([], undefined, undefined, [], true)
    await harness.preStep({ agent: { session: restored }, turn: 2, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: restored.deriveMessages() }))
    expect(restored.surface.nodes).toContain(call.seq)
    expect(restored.surface.nodes).toContain(result.seq)
    expect(foldUserQuestions(restored.snapshotEvents()).active).toMatchObject([{ callId: 'approval-call', state: 'continued' }])
  })

  it('retains native direct Team relay evidence through bounded replay and cold restoration', async () => {
    const session = Session.create(SessionId('native-team-relay'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', user('Review employee result'), { surfaceOp: 'append' })
    const relay = session.append('user/message', createUserMessage({
      source: { kind: 'agent-message', senderSessionId: 'native-worker', form: 'relay' } as never,
      content: [{ type: 'text', text: 'Native saved peer result needing review.' }],
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const original = session.snapshotEvents()
    const restored = Session.create(SessionId('native-team-cold'), original)
    const harness = mount()
    await harness.preStep({ agent: { session: restored }, turn: 2, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: restored.deriveMessages() }))
    expect(restored.surface.nodes).toContain(relay.seq)
    expect(restored.snapshotEvents().slice(0, original.length)).toEqual(original)
  })

  it('retains an unreviewed employee artifact until the exact saved Runtime acceptance', async () => {
    const session = Session.create(SessionId('unreviewed-employee'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', user('Review the delegated work'), { surfaceOp: 'append' })
    const relay = session.append('user/message', createUserMessage({
      source: { kind: 'hivemind-agent-message', messageId: 'employee-report', senderId: 'elena', senderSessionId: 'elena', form: 'relay' } as never,
      content: [{ type: 'text', text: 'Saved artifact and blocking schema failure details' }],
    }), { surfaceOp: 'append' })
    Reflect.apply(session.append, session, ['hivemind/room-message-received', {
      id: 'employee-report', taskId: 'delegated-task', artifactIds: ['saved-artifact'],
    }])
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'The deliverable needs review.' }],
    }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    Reflect.apply(session.append, session, ['team/task', { task: { id: 'delegated-task', revision: 4, status: 'in_progress' } }])
    const harness = mount()
    await harness.preStep({ agent: { session }, turn: 2, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: session.deriveMessages() }))
    expect(session.surface.nodes).toContain(relay.seq)
    Reflect.apply(session.append, session, ['hivemind/hq-task-review', { taskId: 'delegated-task', reviewer: 'runtime',
      status: 'accepted', taskRevision: 4, artifactIds: ['different-artifact'],
    }])
    await harness.preStep({ agent: { session }, turn: 3, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: session.deriveMessages() }))
    expect(session.surface.nodes).toContain(relay.seq)
    Reflect.apply(session.append, session, ['hivemind/hq-task-review', { taskId: 'delegated-task', reviewer: 'runtime',
      status: 'accepted', taskRevision: 4, artifactIds: ['saved-artifact'],
    }])
    await harness.preStep({ agent: { session }, turn: 4, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: session.deriveMessages() }))
    expect(session.surface.nodes).not.toContain(relay.seq)
    expect(session.snapshotEvents().find(event => event.seq === relay.seq)).toEqual(relay)
  })

  it('bounds a megabyte after an old pending approval while preserving exact replay and pairs', async () => {
    const session = Session.create(SessionId('long-pending-approval'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', user('Approval remains pending'), { surfaceOp: 'append' })
    const call = session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id: 'pending' as never, name: 'question', arguments: '{"operation":"exact-original"}' }],
    }) }, { surfaceOp: 'append' })
    const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'pending' as never,
      content: [{ type: 'text', text: 'Waiting for authenticated approval' }], isError: true }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    for (let turn = 2; turn <= 40; turn++) {
      session.append('turn/start', { turn })
      session.append('user/message', user('Unrelated historical request ' + 'x'.repeat(30_000)), { surfaceOp: 'append' })
      session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'Recorded answer' }] }) }, { surfaceOp: 'append' })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const original = session.snapshotEvents()
    const harness = mount([], undefined, undefined, ['pending'])
    await harness.preStep({ agent: { session }, turn: 41, signal: new AbortController().signal } as never, async () => ({ kind: 'enter', messages: [user('Current question')] }))
    expect(JSON.stringify(session.deriveMessages()).length).toBeLessThan(10_000)
    expect(session.surface.nodes).toContain(call.seq)
    expect(session.surface.nodes).toContain(result.seq)
    expect(session.snapshotEvents().slice(0, original.length)).toEqual(original)
    const restored = Session.create(SessionId('long-pending-restored'), session.snapshotEvents())
    expect(restored.deriveMessages()).toEqual(session.deriveMessages())
    expect(restored.eventAt(call.seq)).toEqual(call)
    expect(restored.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('pages a large text tool receipt without changing its identity, outcome or saved original', async () => {
    const session = Session.create(SessionId('large-current-result'))
    session.append('turn/start', { turn: 1 })
    const receipt = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'read-original' as never,
      content: [{ type: 'text', text: 'Exact evidence '.repeat(10_000) }], isError: false }) }, { surfaceOp: 'append' })
    const harness = mount()
    await harness.preStep({ agent: { session }, turn: 1, signal: new AbortController().signal } as never, async () => ({ kind: 'enter', messages: [] }))
    expect(session.eventAt(receipt.seq)).toEqual(receipt)
    const projected = session.deriveMessages()[0]!
    expect(projected.id).toEqual(receipt.data.message.id)
    expect(JSON.stringify(projected.content).length).toBeLessThan(3300)
    expect(JSON.stringify(projected.content)).toContain('hyperagents_history')
    expect(projected.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'read-original', isError: false })
    expect(Session.create(SessionId('large-result-restored'), session.snapshotEvents()).deriveMessages()).toEqual(session.deriveMessages())
  })

  it('shares one result budget across a long active turn while retaining every saved original', async () => {
    const session = Session.create(SessionId('aggregate-current-results'))
    session.append('turn/start', { turn: 1 })
    const originals = Array.from({ length: 12 }, (_, index) => session.append('tool/result', {
      turn: 1, step: index + 1, message: createToolResultMessage({ callId: `saved-${index}` as never,
        content: [{ type: 'text', text: 'Stored evidence '.repeat(400) }], isError: false }),
    }, { surfaceOp: 'append' }))
    const harness = mount()
    await harness.preStep({ agent: { session }, turn: 1, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: [] }))
    const messages = session.deriveMessages()
    expect(messages).toHaveLength(12)
    expect(JSON.stringify(messages).length).toBeLessThan(8000)
    for (const original of originals) expect(session.eventAt(original.seq)).toEqual(original)
    expect(Session.create(SessionId('aggregate-restored'), session.snapshotEvents()).deriveMessages()).toEqual(messages)
  })

  it('starts a greeting with no skill catalog', async () => {
    const harness = mount()
    const catalog = createUserMessage({
      content: [{ type: 'text', text: 'skill catalog' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'unused', description: 'unused' }] },
    })
    const decision = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [user('hello'), catalog],
    })) as { messages: ReturnType<typeof user>[]; startsRequestSeries?: boolean }

    expect(decision.messages).toHaveLength(1)
    expect(decision.startsRequestSeries).toBeUndefined()
  })

  it('does not inject authenticated profile context before the model requests it', async () => {
    const harness = mount()
    const request = user('What do you know about me?')
    const first = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [request],
    })) as { messages: ReturnType<typeof user>[] }
    expect(first.messages).toEqual([request])

    const second = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [request],
    })) as { messages: ReturnType<typeof user>[] }
    expect(second.messages).toEqual([request])
  })

  it('injects a server-owned brief on the first turn and refreshes it for a later direct profile question', async () => {
    const brief = vi.fn(async (_agent: Agent, _signal: AbortSignal, turn: number) => `profile-v${turn}`)
    const harness = mount([], brief)
    const first = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [user('hello')],
    })) as { messages: ReturnType<typeof user>[] }
    const ordinary = await harness.preStep({ agent: harness.agent, turn: 2, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [user('Draft a note')],
    })) as { messages: ReturnType<typeof user>[] }
    const profile = await harness.preStep({ agent: harness.agent, turn: 3, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [user('What is my company profile?')],
    })) as { messages: ReturnType<typeof user>[] }

    const texts = (messages: ReturnType<typeof user>[]) => messages.map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    expect(texts(first.messages)).toEqual(['profile-v1', 'hello'])
    expect(texts(ordinary.messages)).toEqual(['Draft a note'])
    expect(texts(profile.messages)).toEqual(['profile-v3', 'What is my company profile?'])
    expect(brief).toHaveBeenCalledTimes(2)
  })

  it('leaves the first model step to answer or request capabilities', async () => {
    const harness = mount()
    const request = user("Can you tell me exactly what's going on?")
    const catalog = createUserMessage({
      content: [{ type: 'text', text: 'skill catalog' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'unused', description: 'unused' }] },
    })
    const decision = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [request, catalog],
    })) as { messages: ReturnType<typeof user>[]; startsRequestSeries?: boolean }

    expect(decision.startsRequestSeries).toBeUndefined()
    expect(decision.messages).toEqual([request])
  })

  it('reveals the native catalog after the model requests capabilities', async () => {
    const events = [{
      type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'call-1', name: 'hivemind_capabilities', arguments: '{}' },
    }]
    const harness = mount(events)
    const catalog = createUserMessage({
      content: [{ type: 'text', text: 'skill catalog' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'unused', description: 'unused' }] },
    })
    const request = user('Current request')
    const decision = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [request, catalog],
    })) as { messages: ReturnType<typeof user>[] }

    expect(decision.messages).toHaveLength(2)
    expect(decision.messages).toEqual([request, catalog])
  })
})
