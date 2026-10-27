/** Postgres plugins survive a database blip: boot probes retry with backoff and idle pool failures never end the process. */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { containPoolErrors, probePostgresAtBoot } from '../src/postgres-resilience.ts'

describe('probePostgresAtBoot', () => {
  it('retries a refused connection with doubling delays and then starts', async () => {
    let calls = 0
    const probe = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error('connect ECONNREFUSED 172.30.21.1:25432')
    })
    const warn = vi.fn()
    const delays: number[] = []
    await probePostgresAtBoot('fixture', probe, { initAttempts: 5, initRetryDelayMs: 100 }, { warn },
      async (ms) => { delays.push(ms) })
    expect(probe).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([100, 200])
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('fails boot with the last error once the attempts are spent', async () => {
    const probe = vi.fn(async () => { throw new Error('connect ECONNREFUSED') })
    await expect(probePostgresAtBoot('fixture', probe, { initAttempts: 2, initRetryDelayMs: 1 }, { warn: () => {} },
      async () => {})).rejects.toThrow('ECONNREFUSED')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('makes one attempt when retry is not configured', async () => {
    const probe = vi.fn(async () => { throw new Error('down') })
    await expect(probePostgresAtBoot('fixture', probe, {}, { warn: () => {} })).rejects.toThrow('down')
    expect(probe).toHaveBeenCalledOnce()
  })
})

describe('containPoolErrors', () => {
  it('turns an idle client error into a warning instead of an unhandled error event', () => {
    const pool = new EventEmitter()
    const warn = vi.fn()
    containPoolErrors('fixture', pool, { warn })
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Connection terminated unexpectedly'))
  })

})
