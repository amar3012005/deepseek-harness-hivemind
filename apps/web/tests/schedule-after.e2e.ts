/** Real Loader + native browser evidence for the Host-wide Schedule package. */
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { type ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

class ReplyAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Scheduled work completed.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
let app: WebScaffold
let browser: Browser
let page: Page
const adapter = new ReplyAdapter()
const sessionId = SessionId('schedule-native-cold')
let scheduled: ScheduleRecord
beforeAll(async () => {
  app = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('../../cli/config/examples/schedule/cordis.yml', import.meta.url)),
  })
  app.ctx.effect(() => app.ctx.llm.registerAdapter(['schedule-canary'], adapter))
  const handle = await app.ctx.agents.create({
    sessionId,
    meta: { cwd: app.workspaceCwd },
    agentOptions: { provider: 'schedule-canary', model: 'reply' },
  })
  handle.agent.session.append('model/selection', { provider: 'schedule-canary', model: 'reply' })
  const result = await app.ctx.tools.execute({
    name: 'schedule_create',
    callId: ToolCallId('create-native-schedule'),
    arguments: { title: 'Cold session task', prompt: 'Inspect scheduled work', after_seconds: 3600 },
    agent: handle.agent,
    signal: AbortSignal.timeout(10000),
  })
  expect(result.isError).not.toBe(true)
  scheduled = (await app.ctx.schedule.list({ sessionId }))[0]!
  expect(scheduled.title).toBe('Cold session task')
  await app.ctx.sessions.flush(handle.agent.session)
  await handle.dispose()
  expect(app.ctx.agents.get(sessionId)).toBeUndefined()
  browser = await chromium.launch()
  page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  await page.goto(app.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Automation tasks', exact: true }).click({ timeout: 30000 })
})
afterAll(async () => {
  await browser?.close()
  await app?.close()
})

it('opens the built task manager without activating the original session', async () => {
  await page.getByRole('button', { name: 'Cold session task', exact: true }).click()
  expect(await page.getByRole('complementary', { name: 'Task details' }).count()).toBe(1)
  expect(app.ctx.agents.get(sessionId)).toBeUndefined()
  expect(await page.getByText('Inspect scheduled work', { exact: true }).count()).toBeGreaterThan(0)
})

it('compares edits, rejects stale edits, and refreshes the browser catalog', async () => {
  const updated = await app.ctx.schedule.update({
    sessionId,
    id: scheduled.id,
    expected: scheduled,
    title: 'Edited cold task',
  })
  expect(updated).toMatchObject({ updated: true })
  const stale = await app.ctx.schedule.update({
    sessionId,
    id: scheduled.id,
    expected: scheduled,
    title: 'Wrong stale name',
  })
  expect(stale).toMatchObject({ updated: false, code: 'schedule_conflict' })
  scheduled = (await app.ctx.schedule.list({ sessionId }))[0]!
  await page.getByRole('button', { name: 'Edited cold task', exact: true }).waitFor()
  expect(app.ctx.agents.get(sessionId)).toBeUndefined()
})

it('restores a cold session and records a durable native inbox delivery', async () => {
  await app.ctx.schedule.update({
    sessionId,
    id: scheduled.id,
    expected: scheduled,
    title: 'Delivered cold task',
    change: { kind: 'at', at: new Date(Date.now() + 2000).toISOString() },
  })
  await expect.poll(async () => (await app.ctx.schedule.catalog())[0]?.status, { timeout: 15000 }).toBe('inactive')
  await expect.poll(() => adapter.requests.length, { timeout: 15000 }).toBe(1)
  const agent = app.ctx.agents.get(sessionId)!
  await agent.whenIdle()
  await app.ctx.sessions.flush(agent.session)
  expect(
    agent.session
      .ownEvents()
      .filter(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.source.kind === 'schedule')),
  ).toHaveLength(1)
  const history = await app.ctx.schedule.history({ sessionId, id: scheduled.id, limit: 10 })
  expect(history).toHaveProperty('records')
  await page.getByRole('button', { name: 'Delivered cold task', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Delivery records', exact: true }).click()
  await page
    .getByRole('tabpanel', { name: 'Delivery records' })
    .getByText('Inspect scheduled work', { exact: true })
    .first()
    .waitFor()
})

it('deletes a task durably without deleting its session or delivered work', async () => {
  expect(await app.ctx.schedule.delete({ sessionId, id: scheduled.id })).toMatchObject({ deleted: true })
  expect(await app.ctx.schedule.catalog()).toEqual([])
  expect(await app.ctx.sessionPersistence.stat(sessionId)).toBeDefined()
  await page.getByText('No tasks yet. Tasks created in your sessions appear here.', { exact: true }).waitFor()
})
