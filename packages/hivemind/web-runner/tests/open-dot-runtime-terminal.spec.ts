import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExternalEmployeeRoom, ExternalRuntimeDispatchStatus } from '@deepseek-ai/dsh-api-session-controller'
import { reconcileTerminalRuntimeResult, startOpenDotRuntimeMonitor } from '../src/open-dot-runtime.ts'

const employeeId = '67503d34-97e9-49a8-8c52-8ee30cc7603e'
const orgId = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b'
const userId = 'a4f5568b-4d6a-4ae1-9a33-48cb2909d59b'
const rootId = SessionId('session-runtime-root')
const roomId = SessionId('session-open-dot-proxy')
const taskId = 'hq-task-7'
const dispatchId = '12345678-1234-4234-8234-123456789abc'
const secret = 'fixture-open-dot-runtime-service-secret-32'
const sourceFileId = 'file_1234567890abcdef'
const content = Buffer.from('saved result')
const checksum = 'sha256:' + createHash('sha256').update(content).digest('hex')

function fixture(assignment = { employeeId, sessionId: roomId }) {
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  const rootEvents = [{ type: 'hivemind/hq-employee-assignment', data: { taskId, ...assignment } }]
  const root = { id: rootId, session: { header: { parentSession: undefined }, snapshotEvents: () => rootEvents } }
  const room = {
    kind: 'external-persistent-assignee', id: roomId, employeeId, dotId: 'dot_canary', organizationId: orgId,
    userId, name: 'Alex', role: 'Research',
    session: {
      snapshotEvents: () => events,
      append: (type: string, data: Record<string, unknown>) => { events.push({ type, data }) },
    },
  } as unknown as ExternalEmployeeRoom
  const receive = vi.fn(async (_room: ExternalEmployeeRoom, _input: ExternalEmployeeOperation, _signal: AbortSignal) => ({ messageId: 'native-message-1', rootSessionId: rootId }))
  let jobSpec: { run(): { done: Promise<{ status: string }>; cancel(reason?: string): void } } | undefined
  const saveFile = vi.fn(async () => ({ id: 'file_runtime_owned', name: 'result.txt' }))
  const ctx = {
    agents: { get: () => root },
    agentTeams: { getTask: () => ({ revision: 2, status: 'in_progress' }) },
    sessions: { flush: async () => true },
    attachments: { saveFile },
    sessionController: { receiveExternalEmployeeMessage: receive },
    hivemindExecutionScope: { run: (_principal: unknown, callback: () => unknown) => { return callback() } },
    jobs: { start: (spec: NonNullable<typeof jobSpec>) => { jobSpec = spec; return 'open-dot-runtime-1' } },
    logger: { warn: vi.fn() },
  } as unknown as Context
  const receipt = {
    version: 1 as const, dispatchMessageId: dispatchId, nativePacketId: 'native-packet-1', digest: 'd'.repeat(64),
    organizationId: orgId, userId, employeeId, dotId: 'dot_canary', rootSessionId: String(rootId),
    taskId, taskRevision: 2, artifactIds: [], receiptId: 'dot-receipt-1', deliveryState: 'accepted' as const,
    actor: { userId, orgId, name: 'Admin', role: 'administrator' },
  }
  const result: ExternalRuntimeDispatchStatus = {
    state: 'completed', jobResult: { outcome: 'completed', executionStarted: true }, outputs: [
      { messageId: 'output-1', role: 'assistant', text: 'Research summary is ready.', createdAt: '2026-10-12T10:00:00.000Z' },
    ], attachments: [{ id: sourceFileId, name: 'result.txt', mime: 'text/plain', size: content.byteLength }],
  }
  const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
    expect(String(input)).toContain('/internal/v1/harness-chat/core/open-dot/runtime/artifact')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      employee_id: employeeId, dot_id: 'dot_canary', dispatch_message_id: dispatchId,
      root_session_id: String(rootId), artifact_id: sourceFileId,
    })
    return new Response(JSON.stringify({ id: sourceFileId, name: 'result.txt', mime: 'text/plain',
      size: content.byteLength, checksum, dataBase64: content.toString('base64') }), { status: 200 })
  })
  return { ctx, room, receipt, result, receive, saveFile, events, fetchImpl, getJobSpec: () => jobSpec }
}
afterEach(() => vi.restoreAllMocks())

it('reconciles one terminal result as a persisted Runtime review submission with verified owned bytes', async () => {
  const f = fixture()
  await reconcileTerminalRuntimeResult(f.ctx, new URL('https://core.example'), secret, {
    orgId, userId, profile: 'hivemind-chat', variation: 'harness',
  }, f.room, f.receipt, f.result, new AbortController().signal, f.fetchImpl)
  expect(f.saveFile).toHaveBeenCalledTimes(1)
  expect(f.receive).toHaveBeenCalledTimes(1)
  expect(f.receive.mock.calls[0]?.[1]).toMatchObject({
    dispatchMessageId: dispatchId, messageKey: 'runtime-result-' + dispatchId, kind: 'question',
    summary: 'Open Dot result completed; Runtime review required.',
    text: expect.stringContaining('Do not mark this complete based on delivery alone.'),
    artifacts: [{ artifactId: 'open-dot:' + dispatchId + ':' + sourceFileId, title: 'result.txt' }],
  })
  expect(f.events.map(event => event.type)).toEqual(expect.arrayContaining([
    'hivemind/external-artifact-created', 'hivemind/open-dot-runtime-terminal-outbox',
    'hivemind/open-dot-runtime-terminal-receipt',
  ]))
  const firstOutbox = f.events.find(event => event.type === 'hivemind/open-dot-runtime-terminal-outbox')?.data
  await reconcileTerminalRuntimeResult(f.ctx, new URL('https://core.example'), secret, {
    orgId, userId, profile: 'hivemind-chat', variation: 'harness',
  }, f.room, f.receipt, f.result, new AbortController().signal, f.fetchImpl)
  expect(f.receive).toHaveBeenCalledTimes(1)
  expect(f.saveFile).toHaveBeenCalledTimes(1)
  expect(f.events.filter(event => event.type === 'hivemind/open-dot-runtime-terminal-outbox')).toHaveLength(1)
  expect(f.events.find(event => event.type === 'hivemind/open-dot-runtime-terminal-outbox')?.data.digest).toBe(firstOutbox?.digest)
})

it('rejects a changed saved assignment before fetching artifacts or waking a foreign Runtime', async () => {
  const f = fixture({ employeeId: '22222222-2222-4222-8222-222222222222', sessionId: roomId })
  await expect(reconcileTerminalRuntimeResult(f.ctx, new URL('https://core.example'), secret, {
    orgId, userId, profile: 'hivemind-chat', variation: 'harness',
  }, f.room, f.receipt, f.result, new AbortController().signal, f.fetchImpl)).rejects.toThrow('open_dot_runtime_assignment_changed')
  expect(f.fetchImpl).not.toHaveBeenCalled()
  expect(f.receive).not.toHaveBeenCalled()
})

it('does not report a still-running receipt as a result', async () => {
  const f = fixture()
  await reconcileTerminalRuntimeResult(f.ctx, new URL('https://core.example'), secret, {
    orgId, userId, profile: 'hivemind-chat', variation: 'harness',
  }, f.room, f.receipt, { ...f.result, state: 'running' }, new AbortController().signal, f.fetchImpl)
  expect(f.fetchImpl).not.toHaveBeenCalled()
  expect(f.receive).not.toHaveBeenCalled()
})


it('runs terminal reconciliation from the native background job without a Runtime status-tool poll', async () => {
  const f = fixture()
  const status = {
    accepted: true, employeeId, dotId: 'dot_canary', rootSessionId: String(rootId), messageId: dispatchId,
    taskId, taskRevision: 2, kind: 'question', conversationId: 'dot-conversation', jobId: 'dot-job',
    state: 'completed', jobResult: { outcome: 'completed', executionStarted: true },
    outputs: f.result.outputs, attachments: f.result.attachments,
  }
  const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
    if (String(input).endsWith('/open-dot/runtime/status')) return new Response(JSON.stringify(status), { status: 200 })
    return f.fetchImpl(input, init)
  })
  const jobId = startOpenDotRuntimeMonitor(f.ctx, new URL('https://core.example'), secret, {
    orgId, userId, profile: 'hivemind-chat', variation: 'harness',
  }, f.room, f.receipt, { id: rootId } as never, fetchImpl)
  expect(jobId).toBe('open-dot-runtime-1')
  const hooks = f.getJobSpec()?.run()
  expect(hooks).toBeDefined()
  await expect(hooks?.done).resolves.toMatchObject({ status: 'completed' })
  expect(vi.mocked(fetchImpl).mock.calls.some(([input]) => String(input).endsWith('/open-dot/runtime/status'))).toBe(true)
  expect(f.receive).toHaveBeenCalledTimes(1)
  expect(f.events.some(event => event.type === 'hivemind/open-dot-runtime-terminal-receipt')).toBe(true)
})
