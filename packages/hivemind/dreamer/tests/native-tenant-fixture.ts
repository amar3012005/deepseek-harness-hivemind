/** Disposable Dreamer fixture using the product's native Connection admission adapter. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Pool } from 'pg'
import { installTenantTransport } from '../../web-runner/src/tenant-transport.ts'

export const name = 'dreamer-native-tenant-fixture'
export const inject = ['connection', 'typertGateway', 'hivemindExecutionScope', 'sessionPersistence', 'agentPresets']

export async function apply(ctx: Context, config: { schema: string }): Promise<void> {
  const url = process.env.DREAM_CANARY_DB
  if (url === undefined || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/dreamer_test') {
    throw new Error('disposable_dreamer_database_required')
  }
  if (!/^[a-z][a-z0-9_]*$/u.test(config.schema)) throw new Error('invalid_fixture_schema')
  const pool = new Pool({ connectionString: url, options: `-c search_path=${config.schema},public` })
  ctx.effect(() => () => pool.end())
  await installTenantTransport(ctx, {
    secret: 'disposable-dreamer-cookie-secret-not-production',
    membershipActive: async (owner) => {
      const result = await pool.query(`SELECT 1 FROM user_organizations membership JOIN users person ON person.id=membership.user_id
        WHERE membership.org_id=$1 AND membership.user_id=$2 AND membership.is_active=true
        AND membership.deactivated_at IS NULL AND person.deleted_at IS NULL`, [owner.orgId, owner.userId])
      return result.rowCount === 1
    },
    referencedSessionIds: (payload) => {
      const ids = new Set<string>()
      const visit = (value: unknown, depth = 0): void => {
        if (depth > 8 || value === null || typeof value !== 'object') return
        if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return }
        for (const [key, item] of Object.entries(value)) {
          if (['sessionId', 'agentId', 'parentSessionId', 'childSessionId'].includes(key) && typeof item === 'string') ids.add(item)
          else visit(item, depth + 1)
        }
      }
      visit(payload)
      return ids
    },
    referencedSessionAuthorized: async (owner, id, signal) => ctx.hivemindExecutionScope.run(owner, async () => {
      const snapshot = await ctx.sessionPersistence.stat(SessionId(id), { signal })
      return snapshot !== undefined && snapshot.header.parentSession === undefined && snapshot.header.origin !== 'subagent'
    }),
    employeeRoomAuthorized: async () => false,
    resolveAgentPreset: async requested => (await ctx.agentPresets.resolve(requested)).id,
  })
}
