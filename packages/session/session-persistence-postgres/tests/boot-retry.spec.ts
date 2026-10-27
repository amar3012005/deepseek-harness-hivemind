/** Boot survives a transient database connection timeout within the configured attempts. */
import { Context, Service } from '@deepseek-ai/cordis'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { Pool } from 'pg'
import { expect, it, vi } from 'vitest'
import { PostgresSessionPersistence } from '../src/index.ts'

type Init = () => AsyncGenerator<() => Promise<void>, void, void>
function store(attempts: number, failures: number) {
  const ctx = new Context()
  new ExecutionScope(ctx)
  let failed = 0
  const query = vi.fn(async () => {
    if (failed < failures) { failed++; throw new Error('Connection terminated due to connection timeout') }
    return { rows: [] }
  })
  const pool = { query, end: async () => {} } as unknown as Pool
  const persistence = new PostgresSessionPersistence(ctx, { connectionStringEnv: 'FIXTURE', schema: 'hivemind', leaseTtlMs: 30000,
    maxConnections: 1, initAttempts: attempts, initRetryDelayMs: 1 }, pool)
  const init = (persistence as unknown as Record<symbol, Init>)[Service.init as symbol]!.bind(persistence)
  return { ctx, query, init }
}

it('retries the boot probe after a connection timeout and then starts', async () => {
  const { ctx, query, init } = store(3, 2)
  try {
    await expect(init().next()).resolves.toMatchObject({ done: false })
    expect(query).toHaveBeenCalledTimes(3)
  } finally { await ctx.fiber.dispose() }
})

it('fails boot once the configured attempts are spent', async () => {
  const { ctx, query, init } = store(2, 5)
  try {
    await expect(init().next()).rejects.toThrow('connection timeout')
    expect(query).toHaveBeenCalledTimes(2)
  } finally { await ctx.fiber.dispose() }
})
