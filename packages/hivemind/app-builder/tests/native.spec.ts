import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'

const id = '1af82cf7-7431-4567-b7c9-b4ec85f09892'
const spec = { schemaVersion: 1, name: 'CRM', entities: [{ id: 'company', name: 'Company', fields: [{ id: 'name', name: 'Name', type: 'text' }] }], views: [{ id: 'companies', name: 'Companies', type: 'table', entityId: 'company' }] }
const app = { id, version: 1, publishedVersion: null, spec, createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' }
const principal = { orgId: id, userId: id, profile: 'hivemind-chat' as const, variation: 'hyperagents' }

describe('native optional App Builder', () => {
  it('registers scoped tools and a discoverable skill, executes signed HTTP requests and disposes contributions', async () => {
    const seen: { path: string; claims: Record<string, unknown>; body: Record<string, unknown> }[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const claims = JSON.parse(Buffer.from(req.headers.authorization!.split('.')[1]!, 'base64url').toString())
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      seen.push({ path: req.url!, claims, body })
      res.setHeader('content-type', 'application/json')
      const result = req.url!.endsWith('/validate') ? { valid: true, spec } : req.url!.includes('/records?') ? { records: [], nextCursor: null } : { app }
      res.end(JSON.stringify(result))
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('fixture listen failed')
    vi.stubEnv('APP_BUILDER_FIXTURE_SECRET', 'fixture-secret-only-32-bytes-long-1234')
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(Tools)
      await ctx.plugin(Skills)
      await ctx.plugin(ExecutionScope)
      const fiber = await ctx.plugin(plugin, { serviceApiBase: `http://127.0.0.1:${address.port}`, serviceSecretEnv: 'APP_BUILDER_FIXTURE_SECRET' })
      expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('hivemind_app_'))).toHaveLength(9)
      expect((await ctx.skills.get('create-crm'))?.content).toContain('operation_id')
      const execution = { signal: new AbortController().signal } as never
      const call = (name: string, input: unknown) => ctx.hivemindExecutionScope.run(
        principal, () => ctx.tools.get(name)!.execute(input, execution),
      )
      expect(await call('hivemind_app_create_draft', { spec, operation_id: 'fixture:create' })).toEqual({ app })
      expect(await call('hivemind_app_validate', { app_id: id })).toEqual({ valid: true, spec })
      expect(await call('hivemind_app_query_records', { app_id: id, entity_id: 'company' })).toEqual({ records: [], nextCursor: null })
      expect(seen[0]!.claims).toMatchObject({ org_id: id, sub: id, profile: 'hivemind-chat', aud: 'hivemind-control-plane-harness-proxy' })
      expect(seen[0]!.body).toEqual({ spec, operationId: 'fixture:create' })
      expect(seen[0]!.path).toBe('/internal/v1/harness-chat/core/api/app-runtime/apps')
      const before = seen.length
      await expect(call('hivemind_app_create_draft', { spec, operation_id: 'new', organization_id: 'other' })).rejects.toThrow('not a declared property')
      await expect(ctx.hivemindExecutionScope.run({ ...principal, projectId: id }, () => ctx.tools.get('hivemind_app_get')!.execute({ app_id: id }, execution))).rejects.toThrow('project-scoped')
      expect(seen).toHaveLength(before)
      await fiber.dispose()
      expect(ctx.tools.get('hivemind_app_get')).toBeUndefined()
      expect(await ctx.skills.get('create-crm')).toBeUndefined()
    } finally { await ctx.fiber.dispose(); server.close(); await once(server, 'close'); vi.unstubAllEnvs() }
  })
})
