/** Real Cordis loader, native continuable subagent and PostgreSQL cold-session persistence. No paid model calls. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import { launchWebScaffold, type WebScaffold } from '../../../../apps/web/tests/scaffold.ts'
const url = process.env.DSH_DREAM_TEST_URL
const suite = url ? describe : describe.skip
class DreamModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  pause = false
  paused = Promise.withResolvers<undefined>()
  constructor(readonly source: string) {
    super()
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.pause && this.requests.length === 8) {
      this.pause = false
      this.paused.resolve(undefined)
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve()
        else options.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.requests.push(options)
    const calls = [
      ['dream_history', {}],
      ['dream_read', { ids: [this.source] }],
      ['dream_checkpoint', { summary: 'Read source, ready to derive.', next: 'Save connection' }],
      [
        'dream_save',
        {
          title: 'Canary derived connection',
          content: 'A supported canary inference.',
          sourceIds: [this.source],
          entities: ['Canary'],
          reasoningType: 'pattern',
          confidence: 0.6,
        },
      ],
      ['dream_finish', { summary: 'Derived insight saved with provenance.', next: 'Explore newly changed topics next time.' }],
    ] as const
    const [name, args] = calls[(this.requests.length - 1) % calls.length]!
    const id = ToolCallId(`dream-${this.requests.length}`),
      text = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: text }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
suite('native Dreamer workflow', () => {
  const schema = `native_dream_${randomUUID().replaceAll('-', '')}`,
    source = randomUUID(),
    owner: HivemindPrincipal = { orgId: randomUUID(), userId: randomUUID(), profile: 'hivemind-chat', variation: 'harness' }
  let admin: Pool, app: WebScaffold, root: string, cookie: string, base: string, overlay: string, callbackTarget: string | undefined
  const token = 'dream-canary-service-token-1234567890',
    model = new DreamModel(source),
    callbacks: unknown[] = [],
    registrations: unknown[] = []
  const dispatcher = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += String(chunk)
    if (req.method === 'PUT') registrations.push(JSON.parse(text))
    if (req.method === 'POST') {
      callbacks.push(JSON.parse(text))
      if (callbackTarget) {
        const forwarded = await fetch(new URL(req.url!, callbackTarget), {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: text,
        })
        res.writeHead(forwarded.status, { 'content-type': 'application/json' })
        res.end(await forwarded.text())
        return
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(req.method === 'GET' ? JSON.stringify({ triggers: [{ trigger_id: 'dreaming', active: 1, version: 9, next_due_at: Date.parse('2030-01-01T01:00:00Z') }] }) : '{}')
  })
  beforeAll(async () => {
    const parsed = new URL(url!)
    if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/dreamer_test') throw new Error('Disposable local database required')
    admin = new Pool({ connectionString: url, options: `-c search_path=${schema},public` })
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.query(await readFile(new URL('./fixture.sql', import.meta.url), 'utf8'))
    await admin.query((await readFile(new URL('./migration.sql', import.meta.url), 'utf8')).replaceAll('hivemind.', `${schema}.`))
    await admin.query('INSERT INTO organizations(id) VALUES($1)', [owner.orgId])
    await admin.query('INSERT INTO users(id) VALUES($1)', [owner.userId])
    await admin.query('INSERT INTO user_organizations(user_id,org_id) VALUES($1,$2)', [owner.userId, owner.orgId])
    await admin.query(
      "INSERT INTO memories(id,org_id,user_id,title,content,scope) VALUES($1,$2,$3,'Canary evidence','Confirmed canary company evidence.','organization')",
      [source, owner.orgId, owner.userId],
    )
    await new Promise<void>(resolve => dispatcher.listen(0, '127.0.0.1', resolve))
    const port = (dispatcher.address() as { port: number }).port
    base = `http://127.0.0.1:${port}`
    process.env.DREAM_CANARY_DB = url!
    process.env.DREAM_CANARY_DISPATCH = base
    process.env.DREAM_CANARY_TOKEN = token
    root = await mkdtemp(join(tmpdir(), 'dream-native-'))
    await mkdir(join(root, 'presets', 'hivemind-chat'), { recursive: true })
    await writeFile(join(root, 'presets', 'hivemind-chat', 'preset.yml'), 'name: Chat\ndescription: Isolated Dreamer canary\n')
    await writeFile(join(root, 'presets', 'hivemind-chat', 'agent.cordis.yml'), '[]\n')
    overlay = join(root, 'cordis.yml')
    await writeFile(
      overlay,
      `- id: system-prompt
  config: { includeHarnessIdentity: false, includeRuntimeContext: false }
- id: session-persistence-jsonl
  disabled: true
- id: workspace
  disabled: true
- id: workspace-files
  disabled: true
- id: file-reference-local
  disabled: true
- id: directory-picker
  disabled: true
- id: plugin-inventory
  disabled: true
- id: open-in-app
  disabled: true
- id: ui-deliverables
  disabled: true
- insert:
    - id: hivemind-execution-scope
      name: '@deepseek-ai/dsh-hivemind-execution-scope'
    - id: hivemind-virtual-workspace
      name: '@deepseek-ai/dsh-hivemind-virtual-workspace'
    - id: session-persistence-postgres
      name: '@deepseek-ai/dsh-session-persistence-postgres'
      config: { connectionStringEnv: DREAM_CANARY_DB, schema: ${schema}, leaseTtlMs: 30000, maxConnections: 4 }
    - id: hivemind-dreamer
      name: '@deepseek-ai/dsh-hivemind-dreamer'
      config: { connectionStringEnv: DREAM_CANARY_DB, schema: ${schema}, dispatchBaseEnv: DREAM_CANARY_DISPATCH, adminTokenEnv: DREAM_CANARY_TOKEN, dispatchTokenEnv: DREAM_CANARY_TOKEN, callbackTokenEnv: DREAM_CANARY_TOKEN, pollMs: 100, modelProvider: dream-canary, model: dream }
`,
    )
    await boot()
  }, 120000)
  afterAll(async () => {
    await app?.close()
    await new Promise<void>(resolve => dispatcher.close(() => resolve()))
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
    if (root) await rm(root, { recursive: true, force: true })
  }, 30000)
  async function boot() {
    app = await launchWebScaffold({
      extraOverlayPath: overlay,
      extraInstallAnchors: [fileURLToPath(new URL('../../../bundle/hivemind-web-app/package.json', import.meta.url))],
      agentPresets: { includeShippedRoot: false, roots: [{ path: join(root, 'presets'), trust: 'system' }], default: 'hivemind-chat' },
    })
    app.ctx.effect(() => app.ctx.llm.registerAdapter(['dream-canary'], model))
    app.ctx.provide('hivemindMemory', {
      context: async () => ({}),
      profiles: async () => ({}),
      entities: async () => ({}),
      recall: async () => ({}),
      save: async (_agent, request) => {
        expect(request.scope).toBe('project')
        expect(request.derived).toBe(true)
        expect(request.metadata?.dreamer).toBeDefined()
        expect(request.idempotencyKey).toMatch(/^dream:/)
        const id = randomUUID()
        await admin.query("INSERT INTO memories(id,org_id,user_id,title,content,scope,project_id) VALUES($1,$2,$3,$4,$5,'project',$6)", [
          id,
          owner.orgId,
          owner.userId,
          request.title,
          request.content,
          request.project,
        ])
        await admin.query('INSERT INTO source_metadata(memory_id,metadata) VALUES($1,$2::jsonb)', [id, JSON.stringify(request.metadata)])
        return { status: 'saved', memory_id: id }
      },
    })
    cookie = app.ctx.connection
      .authorizePrincipal(
        { headers: { host: new URL(app.baseUrl).host } },
        { org_id: owner.orgId, user_id: owner.userId, profile: owner.profile, variation: owner.variation },
        Date.now() + 3600000,
      )
      .split(';')[0]!
  }
  async function settings(enabled?: boolean) {
    return fetch(`${app.baseUrl}/hivemind/dreamer/settings`, {
      method: enabled === undefined ? 'GET' : 'PUT',
      headers: { cookie, origin: app.baseUrl, 'content-type': 'application/json' },
      ...(enabled === undefined ? {} : { body: JSON.stringify({ enabled }) }),
    })
  }
  function trigger(key: string) {
    return fetch(`${app.baseUrl}/hivemind/dreamer/trigger`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-hivemind-tenant-id': owner.orgId,
        'x-hivemind-trigger-id': 'dreaming',
        'x-hivemind-occurrence-id': key,
        'idempotency-key': key,
        'x-hivemind-scheduled-at': new Date(Number(key.split(':').at(-1))).toISOString(),
      },
      body: JSON.stringify({ workflow: 'dreamer-v1', revision: 1 }),
    })
  }
  it('starts off, opts in once and registers a single versioned workflow', async () => {
    expect((await (await settings()).json()).enabled).toBe(false)
    expect((await settings(true)).status).toBe(200)
    await vi.waitFor(() => expect(registrations).toHaveLength(1))
    expect((registrations[0] as { payload: unknown }).payload).toEqual({ workflow: 'dreamer-v1', revision: 1 })
    await vi.waitFor(async () => {
      const activityResponse = await fetch(`${app.baseUrl}/hivemind/dreamer/settings?view=activity`, { headers: { cookie } })
      const activity = (await activityResponse.json()).activity
      expect(activity.nextRunAt).toBe('2030-01-01T01:00:00.000Z')
      expect(activity.scheduleState).toBe('scheduled')
      expect(activity.runs).toEqual([])
    })
    expect(registrations).toHaveLength(1)

  })
  it('delegates to a real continuable Dreamer and saves directly into Flashbacks', async () => {
    const key = `${owner.orgId}:dreaming:1000`,
      response = await trigger(key)
    expect(response.status).toBe(202)
    const result = (await response.json()) as { runId: string }
    const duplicate = await trigger(key)
    expect((await duplicate.json()).runId).toBe(result.runId)
    await vi.waitFor(
      async () => {
        const rows = await admin.query('SELECT status,output_ids FROM harness_dream_runs WHERE id=$1', [result.runId])
        expect(rows.rows[0].status).toBe('completed')
        expect(rows.rows[0].output_ids).toHaveLength(1)
      },
      { timeout: 20000 },
    )
    const run = (await admin.query('SELECT * FROM harness_dream_runs WHERE id=$1', [result.runId])).rows[0]
    const memories = (
      await admin.query('SELECT m.*,p.name,p.policy FROM memories m JOIN projects p ON p.id=m.project_id WHERE m.id=$1', [
        run.output_ids[0],
      ])
    ).rows
    expect(memories[0].name).toBe('Flashbacks')
    expect(memories[0].policy).toBe('org_visible')
    expect(memories[0].content).toContain('DERIVED FLASHBACK')
    const events = await admin.query('SELECT event_type FROM harness_session_events WHERE session_id=$1', [run.child_id])
    expect(events.rows.some(row => row.event_type === 'subagent/descriptor')).toBe(true)
    await vi.waitFor(() => expect(callbacks).toHaveLength(1))
    expect((callbacks[0] as { status: string }).status).toBe('completed')
    expect(model.requests).toHaveLength(5)
  }, 30000)
  it('resumes the same native child after runner shutdown without writing the same dream twice', async () => {
    model.pause = true
    const response = await trigger(`${owner.orgId}:dreaming:1500`)
    expect(response.status).toBe(202)
    const result = (await response.json()) as { runId: string }
    await model.paused.promise
    const before = (await admin.query('SELECT * FROM harness_dream_runs WHERE id=$1', [result.runId])).rows[0]
    expect(before.checkpoint.summary).toBe('Read source, ready to derive.')
    const parent = app.ctx.agents.get(before.parent_id as never)!
    app.ctx.subagents.interrupt(before.child_id as never, { kind: 'ancestor', agent: parent })
    await vi.waitFor(() => expect(app.ctx.agents.get(before.child_id as never)).toBeUndefined(), { timeout: 5000 })
    await app.close()
    await admin.query("UPDATE harness_dream_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [result.runId])
    await admin.query("UPDATE harness_dream_due SET lease_until=now()-interval '1 second' WHERE org_id=$1", [owner.orgId])
    await boot()
    await vi.waitFor(
      async () => {
        const after = (await admin.query('SELECT * FROM harness_dream_runs WHERE id=$1', [result.runId])).rows[0]
        expect(after.status).toBe('completed')
        expect(after.child_id).toBe(before.child_id)
        expect(after.output_ids).toHaveLength(1)
      },
      { timeout: 20000 },
    )
    expect((await admin.query("SELECT 1 FROM memories WHERE title='Canary derived connection'")).rowCount).toBe(1)
  }, 30000)
  ;(process.env.DSH_DREAM_WORKER_ROOT ? it : it.skip)(
    'dispatches a real local Cloudflare alarm through Queue and reconciles the native completion',
    async () => {
      const workerRoot = process.env.DSH_DREAM_WORKER_ROOT!,
        reservation = createServer()
      await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
      const port = (reservation.address() as { port: number }).port
      await new Promise<void>(resolve => reservation.close(() => resolve()))
      const local = join(root, 'cloudflare'),
        configPath = join(local, 'wrangler.jsonc')
      await mkdir(local, { recursive: true })
      const config = JSON.parse(await readFile(join(workerRoot, 'wrangler.jsonc'), 'utf8'))
      delete config.env
      delete config.$schema
      config.name = 'native-dream-canary'
      config.main = join(workerRoot, 'src/index.ts')
      config.vars = {
        ENVIRONMENT: 'local',
        DISPATCH_ENABLED: 'true',
        DSH_TRIGGER_URL: `${app.baseUrl}/hivemind/dreamer/trigger`,
        DSH_STATUS_BASE_URL: `${app.baseUrl}/hivemind/dreamer/runs`,
        SCHEDULER_ADMIN_TOKEN: token,
        DSH_DISPATCH_TOKEN: token,
        DSH_CALLBACK_TOKEN: token,
      }
      await writeFile(configPath, JSON.stringify(config))
      const worker = spawn(
        process.execPath,
        [
          join(workerRoot, 'node_modules/wrangler/bin/wrangler.js'),
          'dev',
          '--config',
          configPath,
          '--local',
          '--ip',
          '127.0.0.1',
          '--port',
          String(port),
          '--persist-to',
          join(local, 'state'),
          '--log-level',
          'error',
        ],
        { cwd: workerRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
      )
      let log = ''
      worker.stdout.on('data', (chunk) => {
        log += String(chunk)
      })
      worker.stderr.on('data', (chunk) => {
        log += String(chunk)
      })
      const workerBase = `http://127.0.0.1:${port}`
      try {
        await vi.waitFor(
          async () => {
            if (worker.exitCode !== null) throw new Error(log)
            expect((await fetch(`${workerBase}/health`)).ok).toBe(true)
          },
          { timeout: 30000 },
        )
        callbackTarget = workerBase
        const runAt = new Date(Date.now() + 1500).toISOString(),
          response = await fetch(`${workerBase}/v1/tenants/${owner.orgId}/triggers/dreaming`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ schedule: { kind: 'once', runAt }, payload: { workflow: 'dreamer-v1', revision: 1 } }),
          })
        expect(response.ok, log).toBe(true)
        await vi.waitFor(
          async () => {
            const status = await fetch(`${workerBase}/v1/tenants/${owner.orgId}/status`, { headers: { authorization: `Bearer ${token}` } })
            const result = (await status.json()) as { occurrences: Array<{ status: string }> }
            expect(
              result.occurrences.some(value => value.status === 'completed'),
              JSON.stringify(result),
            ).toBe(true)
          },
          { timeout: 25000 },
        )
        expect((await admin.query("SELECT 1 FROM memories WHERE title='Canary derived connection'")).rowCount).toBe(1)
      } finally {
        callbackTarget = undefined
        worker.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          if (worker.exitCode !== null) resolve()
          else worker.once('exit', () => resolve())
        })
      }
    },
    60000,
  )
  it('switches off without deleting prior Flashbacks', async () => {
    expect((await settings(false)).status).toBe(200)
    expect((await (await settings()).json()).enabled).toBe(false)
    expect((await trigger(`${owner.orgId}:dreaming:2000`)).status).toBe(409)
    expect((await admin.query("SELECT 1 FROM memories WHERE title='Canary derived connection'")).rowCount).toBe(1)
  })
})
