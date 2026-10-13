/** A second runner retains tenant reads without scanning or mutating shared schedules. */
import { Context } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
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
