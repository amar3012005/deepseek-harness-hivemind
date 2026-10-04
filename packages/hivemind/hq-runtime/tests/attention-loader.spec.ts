/** Enabled plugin loaded from cordis.yml through real Loader and real HTTP host; no live DB/event delivery. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { it, expect } from 'vitest'

it('mounts packaged enabled attention through Loader, rejects unsigned traffic and disposes HTTP host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-attention-loader-'))
  const context = new Context()
  const secret = 'ATTENTION_LOADER_FIXTURE_SECRET', database = 'ATTENTION_LOADER_FIXTURE_DATABASE'
  process.env[secret] = 'fixture-only-signing-key-32-characters-long'
  process.env[database] = 'postgresql://fixture:fixture@127.0.0.1:1/never_connected'
  // Native delivery dependencies must never be invoked by an unauthenticated request.
  const forbidden = () => { throw Error('unexpected live delivery') }
  const fixture = { name: 'attention-loader-fixture', apply(ctx: Context) {
    ctx.provide('sessionController', { inspect: forbidden, resolveAgent: forbidden } as unknown as Context['sessionController'])
    ctx.provide('sessions', { flush: forbidden } as unknown as Context['sessions'])
    ctx.provide('agents', {} as Context['agents'])
  } }
  try {
    const attention = await import('../lib/attention.js') as typeof import('../src/attention.ts')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'", '  config:', '    host: 127.0.0.1', '    port: 0',
      "- name: '@deepseek-ai/dsh-hivemind-execution-scope'", '- name: attention-loader-fixture',
      "- name: '@deepseek-ai/dsh-hivemind-hq-runtime/attention'", '  config:', '    enabled: true',
      `    serviceSecretEnv: ${secret}`, `    connectionStringEnv: ${database}`, '    schema: hivemind',
      '    triggerSchema: hivemind', '    maxConnections: 1', '    statementTimeoutMs: 1000', '',
    ].join('\n'))
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@deepseek-ai/dsh-hivemind-execution-scope', ExecutionScope],
      ['attention-loader-fixture', fixture], ['@deepseek-ai/dsh-hivemind-hq-runtime/attention', attention],
    ])
    context.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw Error(`unexpected module ${specifier}`)
      return modules.get(specifier)
    } } as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    const port = context.webServer.port
    const response = await fetch(`http://127.0.0.1:${port}/internal/hivemind/runtime-attention`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'context' }),
    })
    expect(response.status).toBe(401)
    await context.fiber.dispose()
    await expect(fetch(`http://127.0.0.1:${port}/internal/hivemind/runtime-attention`)).rejects.toThrow()
  } finally {
    await context.fiber.dispose()
    delete process.env.ATTENTION_LOADER_FIXTURE_SECRET; delete process.env.ATTENTION_LOADER_FIXTURE_DATABASE
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
