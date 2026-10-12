import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { installExternalRoomPersistence } from '../../../api/session-controller/src/external-room.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { installOpenDotRuntimeMonitorRecovery } from '../src/open-dot-runtime.ts'

const rootId = SessionId('session-runtime-cold-recovery-root')
const organizationId = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b'
const userId = 'a4f5568b-4d6a-4ae1-9a33-48cb2909d59b'
const employeeId = '67503d34-97e9-49a8-8c52-8ee30cc7603e'
const dotId = 'dot_runtime_cold_fixture'
const dispatchMessageId = '12345678-1234-4234-8234-123456789abc'
const taskId = 'hq-cold-recovery-task'
const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})
async function mount(root: string, pool: MemoryMediaPool): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('open-dot-cold-fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'open-dot-cold-fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    cwd: '/tmp',
  })
  await ctx.plugin(ScheduleService)
  return ctx
}
it('reattaches a saved Open Dot receipt when a real AgentLoop resumes its persisted Runtime root', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'open-dot-cold-runtime-'))
  roots.push(dataRoot)
  const schedulePool = new MemoryMediaPool()
  const first = await mount(join(dataRoot, 'sessions'), schedulePool)
  const rootSession = first.sessions.prepare(rootId, { meta: { agentPreset: 'hivemind-hq' } })
  rootSession.append('hivemind/session-owner', { id: 'runtime-owner', slug: 'runtime', name: 'Runtime' })
  rootSession.append('turn/start', { turn: 1 })
  rootSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const rootWriter = await first.sessionPersistence.create(rootSession.header)
  await rootWriter.append(rootSession.snapshotEvents())
  const roomHash = createHash('sha256').update(JSON.stringify(['hivemind-open-dot-room-v1', organizationId, userId, employeeId])).digest('hex').slice(0, 40)
  const roomId = SessionId('session-open-dot-' + roomHash)
  const room = first.sessions.prepare(roomId)
  room.append('hivemind/session-owner', { id: employeeId, slug: 'open-dot-employee', name: 'Researcher', role: 'Research' })
  room.append('hivemind/external-employee-room', { employeeId, dotId, organizationId, userId, backend: 'open-dot' })
  room.append('hivemind/open-dot-runtime-dispatch-receipt', {
    version: 1, dispatchMessageId, nativePacketId: 'agent-message-packet-1', digest: 'a'.repeat(64),
    organizationId, userId, employeeId, dotId, rootSessionId: String(rootId), taskId, taskRevision: 3,
    artifactIds: [], receiptId: 'dot-accepted-1', deliveryState: 'accepted',
    actor: { userId, orgId: organizationId, name: 'Admin', role: 'administrator' },
  })
  const roomWriter = await first.sessionPersistence.create(room.header)
  await roomWriter.append(room.snapshotEvents())
  await rootWriter.close()
  await roomWriter.close()
  await first.fiber.dispose()
  contexts.splice(contexts.indexOf(first), 1)

  const second = await mount(join(dataRoot, 'sessions'), schedulePool)
  installExternalRoomPersistence(second)
  const wake = Promise.withResolvers<unknown>()
  const jobs = second.get('jobs')
  if (!jobs) throw new Error('native AgentLoop JobManager is required')
  const startJob = vi.spyOn(jobs, 'start')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    accepted: true, employeeId, dotId, rootSessionId: String(rootId), messageId: dispatchMessageId,
    taskId, taskRevision: 3, kind: 'question', conversationId: 'fixture-conversation', jobId: 'fixture-job',
    state: 'running', jobResult: null, outputs: [], attachments: [],
  }), { status: 200 })))
  second.on('session/event', (session, event) => {
    if (session.id === rootId && event.type === 'hivemind/open-dot-runtime-reconcile-wake') wake.resolve(event.data)
  })
  installOpenDotRuntimeMonitorRecovery(second, new URL('https://core.fixture'), 'fixture-secret-that-is-long-enough')
  second.llm.registerAdapter(['mock'], new MockAdapter([]))
  const resumed = await second.agents.resume({ resumeSessionId: rootId, agentOptions: { provider: 'mock', model: 'mock' } })
  const wakeTimeout = setTimeout(() => wake.reject(new Error('no persisted Open Dot recovery wake')), 5_000)
  await expect(wake.promise).resolves.toMatchObject({
    rootSessionId: String(rootId), dispatchMessageId, employeeId, dotId, roomSessionId: String(roomId),
  })
  clearTimeout(wakeTimeout)
  expect(resumed.agent.session.header.agentPreset).toBe('hivemind-hq')
  expect(resumed.agent.session.ownEvents().filter(event => event.type === 'hivemind/open-dot-runtime-reconcile-wake')).toHaveLength(1)
  await expect.poll(async () => (await second.schedule.catalog()).filter(item => item.sessionId === rootId))
    .toMatchObject([{
      sessionId: rootId, title: "Open Dot Runtime recovery", prompt: expect.stringContaining(dispatchMessageId),
    }])
  await expect.poll(() => startJob).toHaveBeenCalledOnce()
  expect(resumed.agent.session.ownEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
})