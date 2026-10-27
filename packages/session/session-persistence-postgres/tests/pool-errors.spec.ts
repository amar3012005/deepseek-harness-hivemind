/** A dropped idle connection is logged and the pg pool reconnects on the next query instead of ending the process. */
import { Pool } from 'pg'
import { expect, it, vi } from 'vitest'
import { containPoolErrors } from '@deepseek-ai/dsh-hivemind-execution-scope'

it('keeps a real pg Pool usable after an idle client error', async () => {
  const warn = vi.fn()
  const pool = containPoolErrors('fixture', new Pool({ connectionString: 'postgres://127.0.0.1:1/none', connectionTimeoutMillis: 200 }), { warn })
  expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow()
  expect(warn).toHaveBeenCalledOnce()
  // The next query opens a fresh connection; with no server it rejects to its caller rather than crashing.
  await expect(pool.query('SELECT 1')).rejects.toThrow()
  await pool.end()
})
