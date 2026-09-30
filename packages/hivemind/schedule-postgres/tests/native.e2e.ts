/** Real Loader, PostgreSQL session persistence, native restoration and browser task UI. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { chromium, type Browser, type Page } from 'playwright'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import type {} from '../../hq-runtime/src/index.ts'
import { launchWebScaffold, type WebScaffold } from '../../../../apps/web/tests/scaffold.ts'

const url = process.env.DSH_SCHEDULE_TEST_URL
const suite = url === undefined ? describe.skip : describe
class CanaryModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Tenant scheduled work completed.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
suite('tenant scheduled native composition', () => {
  const schema = `native_schedule_${randomUUID().replaceAll('-', '')}`
  const owner: HivemindPrincipal = {
    orgId: randomUUID(),
    userId: randomUUID(),
    profile: 'hivemind-chat',
    variation: 'harness',
  }
  const sessionId = SessionId(`native-${randomUUID()}`)
  const model = new CanaryModel()
  let admin: Pool, app: WebScaffold, browser: Browser, page: Page, root: string, record: ScheduleRecord
  beforeAll(async () => {
    const parsed = new URL(url!)
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/schedule_test')
      throw new Error('Disposable local schedule_test database required')
    admin = new Pool({ connectionString: url, options: `-c search_path=${schema},public` })
    await admin.query(
      `CREATE SCHEMA ${schema}; DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='codex_schedule_test') THEN CREATE ROLE codex_schedule_test NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`,
    )
    await admin.query(await readFile(new URL('./sessions.sql', import.meta.url), 'utf8'))
    await admin.query(await readFile(new URL('../migrations/schedule.sql', import.meta.url), 'utf8'))
    await admin.query(await readFile(new URL('../../hq-runtime/migrations/company-hq.sql', import.meta.url), 'utf8'))
    await admin.query(
      `GRANT USAGE ON SCHEMA ${schema} TO codex_schedule_test; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO codex_schedule_test; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO codex_schedule_test`,
    )
    await admin.query('INSERT INTO users VALUES($1,NULL)', [owner.userId])
    await admin.query('INSERT INTO user_organizations(user_id,org_id) VALUES($1,$2)', [owner.userId, owner.orgId])
    root = await mkdtemp(join(tmpdir(), 'schedule-native-'))
    await mkdir(join(root, 'presets', 'hivemind-hyperagents'), { recursive: true })
    await writeFile(
      join(root, 'presets', 'hivemind-hyperagents', 'preset.yml'),
      'name: HyperAgents\ndescription: Isolated Schedule canary\n',
    )
    await writeFile(join(root, 'presets', 'hivemind-hyperagents', 'agent.cordis.yml'), '[]\n')
    await mkdir(join(root, 'presets', 'hivemind-hq'), { recursive: true })
    await writeFile(join(root, 'presets', 'hivemind-hq', 'preset.yml'), 'name: HQ Runtime\ndescription: Native HQ control canary\n')
    await writeFile(join(root, 'presets', 'hivemind-hq', 'agent.cordis.yml'), '- id: hq-runtime\n  name: "@deepseek-ai/dsh-hivemind-hq-runtime"\n')
    const localUrl = new URL(url!)
    localUrl.searchParams.set('options', `-c role=codex_schedule_test -c search_path=${schema},public`)
    process.env.DSH_SCHEDULE_CANARY_DB = localUrl.toString()
    const overlay = join(root, 'cordis.yml')
    await writeFile(
      overlay,
      `- id: session-persistence-jsonl\n  disabled: true
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
- id: agent-presets
  config:
    includeShippedRoot: false
- id: ui-schedule
  disabled: false
- insert:
    - id: hivemind-employee-directory
      name: '@deepseek-ai/dsh-hivemind-employee-directory'
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config: {allowedRootPresets: [hivemind-hyperagents, hivemind-hq]}
    - id: hivemind-hq-ownership
      name: '@deepseek-ai/dsh-hivemind-hq-runtime/ownership'
    - id: hivemind-hq-ownership-postgres
      name: '@deepseek-ai/dsh-hivemind-hq-runtime/ownership-postgres'
      config: {connectionStringEnv: DSH_SCHEDULE_CANARY_DB, schema: ${schema}, maxConnections: 4, statementTimeoutMs: 15000}
    - id: hivemind-hq-control
      name: '@deepseek-ai/dsh-hivemind-hq-runtime/control'
    - id: ui-hivemind-hq
      name: '@deepseek-ai/dsh-client-ui-hivemind-hq'
    - id: hivemind-virtual-workspace
      name: '@deepseek-ai/dsh-hivemind-virtual-workspace'
    - id: hivemind-execution-scope
      name: '@deepseek-ai/dsh-hivemind-execution-scope'
    - id: session-persistence-postgres
      name: '@deepseek-ai/dsh-session-persistence-postgres'
      config: {connectionStringEnv: DSH_SCHEDULE_CANARY_DB, schema: ${schema}, leaseTtlMs: 30000, maxConnections: 4}
    - id: hivemind-schedule-postgres
      name: '@deepseek-ai/dsh-hivemind-schedule-postgres'
      config: {connectionStringEnv: DSH_SCHEDULE_CANARY_DB, schema: ${schema}, pollIntervalMs: 100, retryIntervalMs: 1000, batchSize: 20, maxConnections: 4, statementTimeoutMs: 15000, maxTasksPerUser: 100}
    - id: schedule
      name: '@deepseek-ai/dsh-schedule'
      inject: [scheduleBackend]
      config: {storage: external}
`,
    )
    app = await launchWebScaffold({
      extraOverlayPath: overlay,
      extraInstallAnchors: [fileURLToPath(new URL('../../../bundle/hivemind-web-app/package.json', import.meta.url))],
      agentPresets: {
        includeShippedRoot: false,
        roots: [{ path: join(root, 'presets'), trust: 'system' }],
        default: 'hivemind-hyperagents',
      },
    })
    app.ctx.effect(() => app.ctx.llm.registerAdapter(['tenant-canary'], model))
    app.ctx.effect(() =>
      app.ctx.connection.registerPrincipalScope((_principal, action) =>
        app.ctx.hivemindExecutionScope.run(owner, action),
      ),
    )
    await app.ctx.hivemindExecutionScope.run(owner, async () => {
      const handle = await app.ctx.agents.create({
        sessionId,
        meta: { agentPreset: 'hivemind-hyperagents', cwd: app.workspaceCwd },
        agentOptions: { provider: 'tenant-canary', model: 'reply' },
      })
      handle.agent.session.append('model/selection', { provider: 'tenant-canary', model: 'reply' })
      const result = await app.ctx.tools.execute({
        name: 'schedule_create',
        callId: ToolCallId('tenant-create'),
        agent: handle.agent,
        signal: AbortSignal.timeout(10000),
        arguments: { title: 'Tenant cold task', prompt: 'Run tenant canary', after_seconds: 3600 },
      })
      expect(result.isError).not.toBe(true)
      record = (await app.ctx.schedule.list({ sessionId }))[0]!
      expect(record).toBeDefined()
      await app.ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    })
    browser = await chromium.launch()
    page = await browser.newPage({ locale: 'en-US' })
    page.on('pageerror', error => console.error('Native browser error:', error.message))
    const cookie = app.ctx.connection
      .authorizePrincipal(
        { headers: { host: new URL(app.baseUrl).host } },
        { org_id: owner.orgId, user_id: owner.userId, profile: owner.profile, variation: owner.variation },
        Date.now() + 3600000,
      )
      .split(';')[0]!
    const equals = cookie.indexOf('=')
    await page
      .context()
      .addCookies([{ name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: app.baseUrl }])
    await page.goto(app.baseUrl)
  }, 120000)
  afterAll(async () => {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: '/tmp/hq-native-browser-diagnostic.png', fullPage: true })
      await writeFile('/tmp/hq-native-browser-diagnostic.txt', await page.locator('body').innerText())
    }
    await browser?.close()
    await app?.close()
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
    if (root) await rm(root, { recursive: true, force: true })
    delete process.env.DSH_SCHEDULE_CANARY_DB
  })
  it('shows tenant tasks in the built UI without resuming their sessions', async () => {
    await page.getByRole('button', { name: 'Automation tasks', exact: true }).click({ timeout: 30000 })
    await page.getByRole('button', { name: 'Tenant cold task', exact: true }).click()
    expect(app.ctx.agents.get(sessionId)).toBeUndefined()
  })
  it('wakes the offline owner through PostgreSQL, restores native history, and refreshes delivery status', async () => {
    await app.ctx.hivemindExecutionScope.run(owner, async () => {
      expect(
        await app.ctx.schedule.update({
          sessionId,
          id: record.id,
          expected: record,
          change: { kind: 'at', at: new Date(Date.now() + 2000).toISOString() },
        }),
      ).toMatchObject({ updated: true })
    })
    await expect.poll(() => model.requests.length, { timeout: 10000 }).toBe(1)
    await expect
      .poll(
        async () =>
          (await admin.query<{ status: string }>('SELECT status FROM harness_scheduled_tasks WHERE id=$1', [record.id]))
            .rows[0]?.status,
        { timeout: 20000 },
      )
      .toBe('inactive')
    const agent = app.ctx.agents.get(sessionId)!
    await agent.whenIdle()
    await app.ctx.sessions.flush(agent.session)
    const inbox = await admin.query<{ payload: SessionEvent<'agent/inbox/spliced'> }>(
      "SELECT payload FROM harness_session_events WHERE session_id=$1 AND event_type='agent/inbox/spliced'",
      [sessionId],
    )
    expect(
      inbox.rows.filter(row =>
        row.payload.data.inserted.some((m: { source: { kind: string } }) => m.source.kind === 'schedule'),
      ),
    ).toHaveLength(1)
    await page.getByRole('tab', { name: 'Delivery records', exact: true }).click()
    await page
      .getByRole('tabpanel', { name: 'Delivery records' })
      .getByText('Run tenant canary', { exact: true })
      .first()
      .waitFor()
    await page.screenshot({ path: '/tmp/hyperagents-schedule-native-preview.png', fullPage: true })
    await app.ctx.hivemindExecutionScope.run(owner, async () => {
      expect(await app.ctx.schedule.delete({ sessionId, id: record.id })).toMatchObject({ deleted: true })
      expect(await app.ctx.schedule.catalog()).toEqual([])
    })
  })
  it('enables HQ from the native browser control, retains one company owner, and pauses it durably', async () => {
    await app.ctx.hivemindExecutionScope.run(owner, async () => {
      const handle = await app.ctx.agents.create({
        sessionId: SessionId(`hq-${randomUUID()}`),
        meta: { agentPreset: 'hivemind-hq', cwd: app.workspaceCwd },
        agentOptions: { provider: 'tenant-canary', model: 'reply' },
      })
      await app.ctx.agentPresets.select(handle.agent, 'hivemind-hq')
      handle.agent.session.append('model/selection', { provider: 'tenant-canary', model: 'reply' })
      const task = await app.ctx.agentTeams.createTask(handle.agent, { subject: 'Verified company brief', description: 'Deliver a sourced artifact.' })
      const request = { action: 'attach', task_id: task.id, due_at: new Date(Date.now() + 3600000).toISOString(), acceptance_criteria: ['One saved sourced report artifact.'] }
      const attach = () => handle.agent.ctx.tools.execute({ name: 'hivemind_hq_contract', callId: ToolCallId(randomUUID()), agent: handle.agent, signal: AbortSignal.timeout(10000), arguments: request })
      const attached = await attach()
      if (attached.isError) throw new Error(JSON.stringify(attached))
      expect((await attach()).isError).not.toBe(true)
      expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'hivemind/hq-task-contract')).toHaveLength(1)
      const deadlines = await app.ctx.schedule.list({ sessionId: handle.agent.id })
      expect(deadlines.filter(item => item.title === 'HQ task deadline: Verified company brief')).toHaveLength(1)
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Prepare HQ controls for this company.' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      handle.agent.session.append('session/title', { title: 'HQ controls canary', messageSeqs: [], source: { kind: 'fallback' } })
      expect(await app.ctx.sessions.flush(handle.agent.session)).toBe(true)
      await handle.dispose()
    })
    await page.reload()
    await page.getByText('Ungrouped', { exact: true }).click({ timeout: 15000 })
    await page.getByText('HQ controls canary', { exact: true }).first().click({ timeout: 15000 })
    await page.getByRole('button', { name: 'Enable HQ', exact: true }).click({ timeout: 15000 })
    await page.getByRole('button', { name: 'Pause HQ', exact: true }).waitFor({ timeout: 15000 })
    const ownership = await admin.query<{ session_id: string }>('SELECT session_id FROM harness_company_hq')
    expect(ownership.rowCount).toBe(1)
    const id = ownership.rows[0]?.session_id
    expect(id).toBeTruthy()
    expect((await admin.query("SELECT 1 FROM harness_scheduled_tasks WHERE session_id=$1 AND record->>'title'='HQ startup review'", [id])).rowCount).toBe(1)
    await page.getByRole('button', { name: 'Pause HQ', exact: true }).click()
    await page.getByRole('button', { name: 'Enable HQ', exact: true }).waitFor()
    const modes = await admin.query<{ payload: { data: { enabled: boolean; revision: number } } }>(
      "SELECT payload FROM harness_session_events WHERE session_id=$1 AND event_type='hivemind/hq-mode' ORDER BY sequence", [id])
    expect(modes.rows.map(row => row.payload.data)).toMatchObject([
      { enabled: true, revision: 1 }, { enabled: false, revision: 2 },
    ])
    await page.reload()
    await page.getByRole('button', { name: 'Enable HQ', exact: true }).waitFor({ timeout: 15000 })
    await page.screenshot({ path: '/tmp/hq-runtime-native-control.png', fullPage: true })
    await page.getByRole('button', { name: 'Automation tasks', exact: true }).click()
    await page.getByRole('button', { name: 'Calendar', exact: true }).click()
    await page.getByText('HQ task deadline: Verified company brief', { exact: true }).waitFor({ timeout: 15000 })
    await page.screenshot({ path: '/tmp/hq-runtime-native-calendar.png', fullPage: true })
    await page.getByRole('button', { name: 'Company calendar', exact: true }).click()
    await page.getByRole('heading', { name: 'Company calendar', exact: true }).waitFor({ timeout: 15000 })
    await page.getByText('Add human work', { exact: true }).click()
    await page.getByLabel('Title', { exact: true }).fill('Owner research review')
    await page.getByLabel('Owner', { exact: true }).fill('Amar')
    await page.getByLabel('Start', { exact: true }).fill('2026-09-30T10:00')
    await page.getByLabel('End', { exact: true }).fill('2026-09-30T11:00')
    await page.getByRole('button', { name: 'Save planned work', exact: true }).click()
    await page.getByRole('heading', { name: 'Owner research review', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Daily agenda', exact: true }).click()
    await page.getByRole('button', { name: /Verified company brief/ }).first().click()
    await page.getByText('No linked saved artifact receipt.', { exact: true }).waitFor()
    expect((await admin.query("SELECT 1 FROM harness_session_events WHERE session_id=$1 AND event_type='hivemind/hq-calendar-item'", [id])).rowCount).toBe(1)
    await page.screenshot({ path: '/tmp/hq-company-workspace.png', fullPage: true })
    await page.getByLabel('Type', { exact: true }).selectOption('assignment')
    await page.getByLabel('Title', { exact: true }).fill('Planned verified brief')
    await page.getByLabel('Owner', { exact: true }).fill('HQ Runtime')
    await page.getByLabel('Start', { exact: true }).fill('2026-10-02T09:00')
    await page.getByLabel('End', { exact: true }).fill('2026-10-02T10:00')
    await page.getByRole('button', { name: 'Save planned work', exact: true }).click()
    await expect.poll(async () => (await admin.query("SELECT 1 FROM harness_session_events WHERE session_id=$1 AND event_type='hivemind/hq-calendar-wake'", [id])).rowCount).toBe(1)
    expect((await admin.query("SELECT 1 FROM harness_scheduled_tasks WHERE session_id=$1 AND record->>'title'='HQ planned work: Planned verified brief'", [id])).rowCount).toBe(1)
    await page.getByRole('button', { name: 'Week calendar', exact: true }).click()
    await page.getByRole('heading', { name: 'Company calendar', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/hq-company-week-calendar.png', fullPage: true })

  })
})
