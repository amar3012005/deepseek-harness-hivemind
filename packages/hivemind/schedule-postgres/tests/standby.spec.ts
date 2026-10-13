/** A second runner retains tenant reads without scanning or mutating shared schedules. */
import { Context } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAtScheduleRecord, ScheduleId } from '@deepseek-ai/dsh-schedule'
import Backend, { type Config } from '../src/index.ts'

const principal = { orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', profile: 'hivemind-hq' as const, variation: 'harness' as const }
const configuration: Config = { connectionStringEnv: 'UNUSED', schema: 'hivemind', pollIntervalMs: 100, retryIntervalMs: 1000, batchSize: 100, maxConnections: 4, statementTimeoutMs: 10000, maxTasksPerUser: 100 }
const contexts: Context[] = []
function fixture(extra: Partial<Config>) {
  const ctx = new Context(); contexts.push(ctx)
  const scope = new ExecutionScope(ctx)
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 1 }))
  const client = { query, release: vi.fn() }
  const connect = vi.fn(async () => client)
  const pool = { connect, query, end: vi.fn(async () => {}) } as unknown as Pool
  const backend = new Backend(ctx, { ...configuration, ...extra }, pool)
  return { backend, scope, query, connect }
}
afterEach(async () => { vi.useRealTimers(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

describe('standby Schedule deployment', () => {
  it('does not install wake timers or acquire a database connection for dispatch', async () => {
    vi.useFakeTimers()
    const { backend, connect } = fixture({ dispatchEnabled: false })
    const wake = vi.fn(); const work = vi.fn(async () => {})
    const stop = backend.start(wake)
    await vi.advanceTimersByTimeAsync(1000)
    expect(wake).not.toHaveBeenCalled()
    expect(await backend.dispatch(work)).toBe(false)
    expect(work).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled()
    stop()
  })
  it('preserves ordinary automatic wakes when no standby setting is supplied', async () => {
    vi.useFakeTimers()
    const { backend } = fixture({})
    const wake = vi.fn(); const stop = backend.start(wake)
    await vi.advanceTimersByTimeAsync(100)
    expect(wake).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(wake).toHaveBeenCalledTimes(2)
  })
  it('keeps reads inside the authenticated tenant transaction but rejects all task mutations', async () => {
    const { backend, scope, query } = fixture({ managementEnabled: false })
    expect(await scope.run(principal, () => backend.manage(async table => [...table.entries()]))).toEqual([])
    const id = ScheduleId('standby-task')
    const task = { sessionId: SessionId('standby-session'), record: createAtScheduleRecord(id, 'Do not dispatch', new Date(Date.now() + 60000).toISOString(), 0, 'Standby task'), status: 'active' as const }
    await expect(scope.run(principal, () => backend.manage(table => table.put(id, task)))).rejects.toThrow('schedule_management_disabled_for_runner')
    await expect(scope.run(principal, () => backend.manage(table => table.delete(id)))).rejects.toThrow('schedule_management_disabled_for_runner')
    expect(query.mock.calls.some(([sql, values]) => sql.includes("set_config('app.hivemind_org_id'") && values?.[0] === principal.orgId && values?.[1] === principal.userId)).toBe(true)
    expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)\b/u.test(sql))).toBe(false)
  })
})

describe('native runner schedule ownership', () => {
  it('skips another runner before mutation or restore under tenant RLS', async () => {
    const { backend, query } = fixture({ ownedPresets: ['hivemind-hq', 'hivemind-hyperagents'] })
    query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT task_id,org_id,user_id FROM harness_scheduled_due')
      ? [{ task_id: 'foreign-task', org_id: principal.orgId, user_id: principal.userId }]
      : sql.includes('AS preset FROM harness_sessions') ? [{ preset: 'hivemind-chat' }] : [], rowCount: 1 }) as never)
    const work = vi.fn(async () => {})
    expect(await backend.dispatch(work)).toBe(false)
    expect(work).not.toHaveBeenCalled()
    expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)\b/u.test(sql))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes("set_config('app.hivemind_org_id'"))).toBe(true)
  })
  it('limits native management queries and forbids deleting hidden foreign schedules', async () => {
    const { backend, scope, query } = fixture({ ownedPresets: ['hivemind-chat'] })
    await expect(scope.run(principal, () => backend.manage(table => table.delete(ScheduleId('foreign-task'))))).rejects.toThrow('schedule_not_owned_by_runner')
    expect(query.mock.calls.some(([sql, values]) => sql.includes('ANY($4::text[])') && JSON.stringify(values?.[3]) === '["hivemind-chat"]')).toBe(true)
    expect(query.mock.calls.some(([sql]) => /^DELETE\b/u.test(sql))).toBe(false)
  })
})
