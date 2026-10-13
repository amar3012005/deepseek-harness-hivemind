import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { expect, it } from 'vitest'
import { contextPlugin } from '../../context/src/index.ts'
import { installFullAccessPolicySnapshot } from '../src/full-access-policy.ts'

class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length % 3 !== 0) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`call-${this.requests.length}`),
        name: 'scoped_fixture', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Saved result verified.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function fixture(revoke: boolean | 'disabled' = false) {
  const ctx = new Context()
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin)
  let checks = 0
  await ctx.plugin({ name: 'operator-policy-fixture', apply(scope: Context) {
    installFullAccessPolicySnapshot(scope, async () => { checks++; return revoke === 'disabled' ? false : !revoke || checks !== 2 })
  } })
  await ctx.plugin(contextPlugin({ historyTurns: 2, historyMaxChars: 4000, capabilityToolName: 'hivemind_capabilities' }))
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  ctx.tools.register(defineContentToolFixture({ name: 'scoped_fixture', description: 'Disposable scoped proof', parameters: {},
    async execute() { return [{ type: 'text', text: 'Saved scoped receipt.' }] } }))
  const agent = await ctx.agentLoop.create(SessionId('scoped-policy-fixture'), { provider: 'fixture', model: 'fixture' })
  return { ctx, adapter, agent, checks: () => checks }
}

it('checks permission on every real loop step but does not append unchanged policy after tool results', async () => {
  const f = await fixture()
  const request = 'Review and complete task-24 only. Leave every other task untouched.'
  try {
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: request }] }))
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(3)
    expect(f.checks()).toBe(3)
    const notes = f.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && isAppendSurfaceEvent(event)
      && event.data.source.kind === 'plugin' && event.data.source.plugin === 'hivemind-runtime-full-access')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.data.source).toMatchObject({ form: 'snapshot' })
    const firstToolResult = f.agent.session.snapshotEvents().find(event => event.type === 'tool/result')!
    expect(notes[0]!.seq).toBeLessThan(firstToolResult.seq)
    for (const assembled of f.adapter.requests) {
      expect(assembled.messages.some(message => message.source?.kind === 'user'
        && message.content.some(block => block.type === 'text' && block.text === request))).toBe(true)
    }
    for (const assembled of f.adapter.requests.slice(1)) {
      expect(assembled.messages.filter(message => message.role === 'user' && message.content.every(block => block.type === 'text')).at(-1)?.content)
        .toEqual([{ type: 'text', text: request }])
    }
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(2)
  } finally { await f.ctx.fiber.dispose() }
})

it('emits an actual authority change without skipping subsequent permission checks', async () => {
  const f = await fixture(true)
  try {
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Scoped proof only.' }] }))
    await f.agent.whenIdle()
    expect(f.checks()).toBe(3)
    const notes = f.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && isAppendSurfaceEvent(event)
      && event.data.source.kind === 'plugin' && event.data.source.plugin === 'hivemind-runtime-full-access')
    expect(notes).toHaveLength(3)
    expect(JSON.stringify(notes[1]?.data)).toContain('no longer admitted')
    expect(JSON.stringify(notes[2]?.data)).toContain('administrator explicitly selected')
  } finally { await f.ctx.fiber.dispose() }
})

it('cold restoration clears an old enabled snapshot when fresh authority is disabled', async () => {
  const original = await fixture()
  let seed
  try {
    original.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'First scoped proof.' }] }))
    await original.agent.whenIdle()
    seed = JSON.parse(JSON.stringify(original.agent.session.snapshotEvents()))
  } finally { await original.ctx.fiber.dispose() }
  const restored = await fixture('disabled')
  try {
    const id = SessionId('restored-scoped-policy')
    const loaded = await restored.ctx.agentLoop.createAgent(restored.ctx, { sessionId: id, seed,
      agentOptions: { provider: 'fixture', model: 'fixture' } })
    loaded.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue scoped proof only.' }] }))
    await loaded.agent.whenIdle()
    expect(restored.checks()).toBe(3)
    const policy = loaded.agent.session.deriveMessages().filter(message => message.source?.kind === 'plugin'
      && message.source.plugin === 'hivemind-runtime-full-access')
    expect(JSON.stringify(policy)).toContain('no longer admitted')
    expect(JSON.stringify(policy)).not.toContain('administrator explicitly selected')
    expect(restored.adapter.requests).toHaveLength(3)
  } finally { await restored.ctx.fiber.dispose() }
})
