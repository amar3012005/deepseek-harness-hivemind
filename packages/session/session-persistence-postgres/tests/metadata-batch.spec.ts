import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { Pool } from 'pg'
import { expect, it } from 'vitest'
import { PostgresSessionPersistence } from '../src/index.ts'

it('batches metadata while retaining lineage, fresh admin proof, denial and scoped filtering', async () => {
  const ctx = new Context(), scope = new ExecutionScope(ctx)
  const owner = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b'
  const principal = { orgId: '67503d34-97e9-49a8-8c52-8ee30cc7603e', userId: '64f5568b-4d6a-4ae1-9a33-48cb2909d59b', profile: 'hivemind-chat' as const, variation: 'harness' }
  const row = (id: string, preset: string, parent?: string, started = false) => ({
    header: { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, agentPreset: preset,
      ...(parent === undefined ? {} : { parentSession: SessionId(parent) }) },
    inherited_event_count: 0, event_count: 0, revision: 0, preset, started,
  })
  const personal = [row('brain', 'hivemind-chat'), row('legacy-agent', 'hivemind-hq')]
  const shared = [row('runtime', 'hivemind-hq', undefined, true), row('employee', 'hivemind-hyperagents'), row('child', 'other', 'employee', true), row('foreign-brain', 'hivemind-chat'), row('cycle', 'other', 'cycle'), row('missing-parent', 'other', 'absent')]
  for (let i = 0; i < 500; i++) shared.push(row(`employee-${i}`, 'hivemind-hyperagents'))
  let authorized = true, metadataQueries = 0, proofs = 0, failDatabase = false
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('organization_agent_storage_scope')) {
      proofs++; expect(values).toEqual([principal.orgId, principal.userId])
      return { rows: authorized ? [{ storage_user_id: owner }] : [] }
    }
    if (sql.includes('FROM harness_sessions s')) {
      metadataQueries++; expect(values[0]).toBe(principal.orgId)
      expect(sql).toContain('e.org_id=s.org_id AND e.user_id=s.user_id')
      if (failDatabase && values[1] === owner) throw Error('database_unavailable')
      return { rows: values[1] === owner ? shared : personal }
    }
    return { rows: [] }
  }
  const pool = { connect: async () => ({ query, release: () => {} }) } as unknown as Pool
  const store = new PostgresSessionPersistence(ctx, { connectionStringEnv: 'FIXTURE', schema: 'hivemind', leaseTtlMs: 30000, maxConnections: 3, sharedOrganizationAgents: true }, pool)
  try {
    await expect(store.list()).rejects.toThrow(/scope is unavailable/u)
    const list = await scope.run(principal, () => store.list())
    expect(list).toHaveLength(504)
    expect(list.map(item => item.header.id)).not.toEqual(expect.arrayContaining(['foreign-brain', 'cycle', 'missing-parent', 'legacy-agent']))
    expect(metadataQueries).toBe(2); expect(proofs).toBe(1)
    const ids = [SessionId('runtime'), SessionId('child'), SessionId('brain'), SessionId('foreign-brain'), SessionId('absent')]
    expect(await scope.run(principal, () => store.effectivePresets(ids))).toEqual(new Map([['runtime', 'hivemind-hq'], ['child', 'other'], ['brain', 'hivemind-chat']]))
    expect(await scope.run(principal, () => store.startedSessions(ids))).toEqual(new Set(['runtime', 'child']))
    expect(metadataQueries).toBe(6); expect(proofs).toBe(3)
    await expect(scope.run(principal, () => store.effectivePresets([SessionId('legacy-agent')]))).rejects.toThrow()
    authorized = false
    expect((await scope.run(principal, () => store.list())).map(item => item.header.id)).toEqual(['brain'])
    expect(await scope.run(principal, () => store.effectivePresets(ids))).toEqual(new Map([['brain', 'hivemind-chat']]))
    await expect(scope.run(principal, () => store.startedSessions([SessionId('legacy-agent')]))).rejects.toThrow('organization_agent_admin_required')
    authorized = true; failDatabase = true
    await expect(scope.run(principal, () => store.list())).rejects.toThrow('database_unavailable')
    const abort = new AbortController(); abort.abort()
    await expect(scope.run(principal, () => store.list({ signal: abort.signal }))).rejects.toThrow()
  } finally { await ctx.fiber.dispose() }
})
