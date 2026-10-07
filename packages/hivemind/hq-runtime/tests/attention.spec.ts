import { createHmac, randomUUID } from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/attention.ts'
import { attentionMemorySnapshot } from '../src/attention-memory.ts'
import { attentionAdmitted, attentionAuthorization, attentionEvidence, attentionSnapshot } from '../src/attention-contract.ts'

const database = vi.hoisted(() => ({ row: undefined as unknown, queries: [] as unknown[], memory: [] as unknown[] }))
vi.mock('pg', () => ({ Pool: class {
  async connect() { return { query: async (sql: string, args?: unknown[]) => {
    database.queries.push({ sql, args }); return { rows: sql.includes('SELECT h.session_id') && database.row ? [database.row] : sql.includes('WITH heads') ? database.memory : [] }
  }, release() {} } }
  async end() {}
} }))
const orgId = '11111111-1111-4111-8111-111111111111', userId = '22222222-2222-4222-8222-222222222222'
const token = 'test-attention-token-with-32-characters'
const mode = { type: 'hivemind/hq-mode', data: { revision: 1, enabled: true, changedAt: 1 } }
function signedToken(operation: string) {
  const at = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: 'hivemind-control-plane', aud: 'hivemind-runtime-attention', sub: userId, org_id: orgId, event_id: 'event', operation, iat: at, exp: at + 30, jti: randomUUID() })}`
  return `${input}.${createHmac('sha256', token).update(input).digest('base64url')}`
}
function fixture(allowedOrgIds = [orgId]) {
  const events: { type: string; data: unknown }[] = [mode]
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => { throw Error('not_registered') }
  const send = vi.fn((message: unknown) => { events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }) })
  const flush = vi.fn(async () => true)
  const target = { session: { snapshotEvents: () => events }, send }
  const ctx = { webServer: { register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } },
    effect: (effect: () => unknown) => effect(),
    hivemindExecutionScope: { run: async (_scope: unknown, operation: () => unknown) => operation() },
    sessionController: { inspect: async () => ({ meta: { agentPreset: 'hivemind-hq' }, events }), resolveAgent: async () => ({ agent: target }) },
    sessions: { flush } } as unknown as Context
  apply(ctx, { enabled: true, allowedOrgIds, admitEventsAfter:'2026-10-01T00:00:00Z', serviceSecretEnv: 'ATTENTION_TEST_TOKEN', connectionStringEnv: 'ATTENTION_TEST_DATABASE', schema: 'hivemind', triggerSchema: 'public', maxConnections: 1, statementTimeoutMs: 1000 })
  const snapshot = attentionSnapshot(events, 'session-owned-root', 1, attentionMemorySnapshot(database.memory as never[]))
  database.row = { session_id: 'session-owned-root', subscription_id: 'subscription', runtime_attention_revision: 1,
    org_id: orgId, user_id: userId, toolkit: 'slack', occurred_at: null, received_at:'2026-10-08T00:00:00Z', data: { text: 'Buyer approval arrived.', api_key: 'secret' },
    relevance_status: 'approved', relevance_decision: { runtimeAttention: { policy: 'runtime_attention_v2', action: 'wake',
      contextRevision: snapshot.revision, targetSessionId: 'session-owned-root', probability: 0.9, margin: 0.5 } } }
  async function request(operation = 'deliver', authorization = `Bearer ${signedToken(operation)}`) {
    const req = { method: 'POST', headers: { authorization }, async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ operation, eventId: 'event', orgId, userId }))
    } }
    let status = 0, result: unknown
    const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true },
      end(value: string) { result = JSON.parse(value) as unknown } }
    await handler(req, res); return { status, result }
  }
  return { request, send, flush, events }
}
beforeEach(() => { database.row = undefined; database.queries = []; database.memory = []; process.env.ATTENTION_TEST_TOKEN = token; process.env.ATTENTION_TEST_DATABASE = 'mock-only' })
describe('authenticated native attention seam', () => {
  it('validates service token before any owner lookup', async () => {
    const f = fixture(); expect((await f.request('context', 'Bearer invalid')).status).toBe(401)
    expect(database.queries).toHaveLength(0); expect(f.send).not.toHaveBeenCalled()
    expect(attentionAuthorization(`Bearer ${signedToken('context')}`, token)?.operation).toBe('context')
    expect(attentionAuthorization(`Bearer ${token}`, token)).toBeUndefined()
  })
  it('rejects tampered, expired and foreign-purpose signed credentials', () => {
    const signed = signedToken('context')
    expect(attentionAuthorization(`Bearer ${signed}x`, token)).toBeUndefined()
    expect(attentionAuthorization(`Bearer ${signed}`, token, Date.now() + 31000)).toBeUndefined()
    expect(attentionAuthorization(`Bearer ${signed}`, 'different-key-with-at-least-32-characters')).toBeUndefined()
  })
  it('requires opted-in active membership, owner and canonical root lookup', async () => {
    const f = fixture(); database.row = undefined
    expect((await f.request()).status).toBe(403); expect(f.send).not.toHaveBeenCalled()
    expect(JSON.stringify(database.queries)).toContain('runtime_attention_enabled_at')
    expect(JSON.stringify(database.queries)).toContain('m.is_active')
    expect(JSON.stringify(database.queries)).toContain('h.user_id=e.user_id')
  })
  it('concurrent delivery retries remain one logical native admission', async () => {
    const f=fixture(); const results=await Promise.all([f.request(),f.request()])
    expect(results.map(value=>value.status)).toEqual([202,200]); expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('empty or other-company allowlist denies before reading private context', async () => {
    const f=fixture([]);expect((await f.request('context')).status).toBe(403);expect(database.queries).toHaveLength(0);expect(f.send).not.toHaveBeenCalled()
  })
  it('context reads do not activate or wake an agent', async () => {
    const f = fixture(); expect((await f.request('context')).status).toBe(200)
    expect(f.send).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled()
  })
  it('admits once through native next-turn wake and durable flush', async () => {
    const f = fixture(); expect((await f.request()).status).toBe(202)
    expect(f.send).toHaveBeenCalledWith(expect.anything(), 'next-turn', true)
    expect((await f.request()).status).toBe(200); expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.flush).toHaveBeenCalledTimes(2)
    expect(attentionAdmitted(f.events, 'event')).toBe(true)
    expect(JSON.stringify(f.send.mock.calls)).not.toContain('secret')
  })
  it('reconciles unknown flush outcome without duplicate admission', async () => {
    const f = fixture(); f.flush.mockResolvedValueOnce(false)
    expect((await f.request()).status).toBe(503)
    expect((await f.request()).status).toBe(200)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('rejects stale context and disabled autonomy without waking', async () => {
    const f = fixture(); f.events.push({ type: 'hivemind/hq-mode', data: { revision: 2, enabled: false, changedAt: 2 } })
    expect((await f.request()).status).toBe(409); expect(f.send).not.toHaveBeenCalled()
  })
  it('fresh private-memory changes invalidate a prior decision before wake', async () => {
    const f=fixture(); database.memory=[{ id:'new',kind:'user_agenda',title:'Direction',summary:'Changed direction',context:{ state:'confirmed',priority:50 },created_at:'2026-10-08T00:00:00Z',total:1 }]
    expect((await f.request()).status).toBe(409); expect(f.send).not.toHaveBeenCalled()
  })
  it('private query enforces org, owner, Runtime lane and successor exclusions', async () => {
    const f=fixture(); expect((await f.request('context')).status).toBe(200)
    const queries=JSON.stringify(database.queries); expect(queries).toContain('m.author_user_id=$2'); expect(queries).toContain('successor.author_user_id=m.author_user_id'); expect(queries).toContain("m.agent_slug='runtime'")
  })
  it('old backlog is inspectable for shadow review but never admitted', async () => {
    const f=fixture();(database.row as { received_at:string }).received_at='2026-09-30T00:00:00Z'
    expect((await f.request('context')).status).toBe(200);expect((await f.request()).status).toBe(409);expect(f.send).not.toHaveBeenCalled()
  })
  it('notify is not confused with non-waking inbox delivery', async () => {
    const f = fixture(); const row = database.row as { relevance_decision: { runtimeAttention: { action: string } } }
    row.relevance_decision.runtimeAttention.action = 'notify'
    expect((await f.request()).status).toBe(409); expect(f.send).not.toHaveBeenCalled()
  })
  it('fresh mode epoch and task changes invalidate old decisions', () => {
    const first = attentionSnapshot([mode], 'root', 1)
    expect(attentionSnapshot([{ ...mode, data: { ...mode.data, changedAt: 2 } }], 'root', 1).revision).not.toBe(first.revision)
    expect(attentionSnapshot([mode], 'root', 2).revision).not.toBe(first.revision)
    expect(attentionSnapshot([mode, { type: 'team/task', data: { task: { id: 'task', status: 'completed', subject: 'Review' } } }], 'root', 1).revision).not.toBe(first.revision)
  })
  it('real Gmail object preview cannot hide plain message text at native delivery', () => {
    const source = attentionEvidence({ preview: { body: 'short', credentials: 'secret' }, message_text: 'Actual plain text' })
    expect(source.preview).toBe('Actual plain text')
    expect(attentionEvidence({ preview: { body: 'Fallback plain text' } }).preview).toBe('Fallback plain text')
    expect(JSON.stringify(source)).not.toContain('secret')
    expect(JSON.stringify(source)).not.toContain('[object Object]')
  })
  it('source projection is bounded and excludes provider credential fields', () => {
    const source = attentionEvidence({ text: 'x'.repeat(5000), credentials: 'secret', nested: { token: 'secret' } })
    expect(source.preview).toHaveLength(1500); expect(JSON.stringify(source)).not.toContain('secret')
  })
})
