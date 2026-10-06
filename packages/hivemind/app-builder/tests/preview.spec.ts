/** Opt-in real Core + Control preview proof. Use only a disposable fixture organization. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

const origin = process.env.CRM_NATIVE_PREVIEW_ORIGIN
const suite = origin ? describe : describe.skip
suite('real authenticated disposable App Runtime preview', () => {
  it('loads the progressive skill and executes all nine native tools', async () => {
    const orgId = process.env.CRM_NATIVE_PREVIEW_ORG_ID
    const userId = process.env.CRM_NATIVE_PREVIEW_USER_ID
    if (!orgId || !userId || !process.env.CRM_NATIVE_PREVIEW_SERVICE_SECRET)
      throw Error('Explicit disposable preview organization, user and service secret required')
    const url = new URL(origin!)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('Use a loopback disposable preview tunnel')
    const ctx = new Context()
    const operation = `native-preview-${randomUUID()}`
    const principal = { orgId, userId, profile: 'hivemind-chat' as const, variation: 'hyperagents' }
    const call = (name: string, args: unknown) => ctx.hivemindExecutionScope.run(
      principal, () => ctx.tools.get(name)!.execute(args, { signal: new AbortController().signal } as never),
    )
    try {
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(Tools)
      await ctx.plugin(Skills)
      await ctx.plugin(ExecutionScope)
      await ctx.plugin(plugin, { serviceApiBase: origin!, serviceSecretEnv: 'CRM_NATIVE_PREVIEW_SERVICE_SECRET', requestTimeoutMs: 30_000, maxRequestBytes: 262_144, maxResponseBytes: 1_048_576 })
      expect((await ctx.skills.get('create-crm'))?.content).toContain('operation_id')
      expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('hivemind_app_'))).toHaveLength(9)
      const spec = {
        schemaVersion: 1, name: `Native preview ${operation}`, entities: [{ id: 'company', name: 'Companies', fields: [
          { id: 'name', name: 'Name', type: 'text', required: true },
        ] }], views: [{ id: 'companies', name: 'Companies', type: 'table', entityId: 'company' }],
      }
      const created = await call('hivemind_app_create_draft', { spec, operation_id: `${operation}:create` }) as { app: { id: string; version: number } }
      const appId = created.app.id
      expect(await call('hivemind_app_get', { app_id: appId })).toMatchObject(created)
      const updatedSpec = { ...spec, description: 'Verified through native tools and the authenticated Control gateway.' }
      const patched = await call('hivemind_app_patch', { app_id: appId, expected_version: created.app.version, spec: updatedSpec, operation_id: `${operation}:patch` }) as { app: { version: number } }
      expect(await call('hivemind_app_validate', { app_id: appId })).toMatchObject({ valid: true, spec: updatedSpec })
      expect(await call('hivemind_app_preview', { app_id: appId })).toMatchObject({ app: { spec: updatedSpec } })
      expect(await call('hivemind_app_publish', { app_id: appId, expected_version: patched.app.version, operation_id: `${operation}:publish` })).toMatchObject({ app: { publishedVersion: patched.app.version } })
      const record = await call('hivemind_app_create_record', { app_id: appId, entity_id: 'company', data: { name: 'Disposable native fixture' }, operation_id: `${operation}:record` }) as { record: { id: string; version: number } }
      await call('hivemind_app_update_record', { app_id: appId, record_id: record.record.id, expected_version: record.record.version, data: { name: 'Updated native fixture' }, operation_id: `${operation}:update` })
      expect(await call('hivemind_app_query_records', { app_id: appId, entity_id: 'company' })).toMatchObject({ records: [{ data: { name: 'Updated native fixture' } }] })
      await expect(ctx.hivemindExecutionScope.run({ ...principal, projectId: randomUUID() }, () => ctx.tools.get('hivemind_app_get')!.execute({ app_id: appId }, { signal: new AbortController().signal } as never))).rejects.toThrow('project-scoped')
      console.info(JSON.stringify({ receipt: 'native-app-builder-preview', appId, operation, toolCount: 9, skill: 'create-crm', projectScopeDenied: true }))
    } finally { await ctx.fiber.dispose() }
  }, 60_000)
})
