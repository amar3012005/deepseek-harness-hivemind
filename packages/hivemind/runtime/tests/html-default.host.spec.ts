/** Verify shipped persona policy in native model requests for each input origin. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Persona from '@deepseek-ai/dsh-persona'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-schedule'
import { DEFAULT_SCHEMA, load, Type } from 'js-yaml'
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

it.each(['hivemind-hq', 'hivemind-hyperagents'])('keeps the HTML default and explicit format requests in every native %s input', async (profile) => {
  const ctx = new Context()
  const messages = [
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Wake up and prepare a customer report.' }] }),
    createUserMessage({ source: { kind: 'hivemind-runtime-context', plugin: 'hivemind-runtime/voice-outcome', form: 'recall' }, content: [{ type: 'text', text: 'Continue the saved authorized task after the call.' }] }),
    createUserMessage({ source: { kind: 'schedule', form: 'notice', summary: 'Customer evidence follow-up', occurrenceAt: '2026-10-11T10:00:00.000Z' }, content: [{ type: 'text', text: 'Resume the scheduled customer evidence task.' }] }),
    createUserMessage({ source: { kind: 'hivemind-agent-message', form: 'relay', messageId: 'employee-result',
      senderId: SessionId('employee-room'), senderSessionId: SessionId('employee-room') }, content: [{ type: 'text', text: 'The requested customer evidence is ready for review.' }] }),
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Please deliver the final customer report as PDF.' }] }),
  ]
  const adapter = new MockAdapter(messages.map(() => textResponse('I will continue the authorized work.')))
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const schema = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))
    const rows = load(await readFile(new URL(`../../../../packages/bundle/hivemind-web-app/presets/${profile}.patch.yml`, import.meta.url), 'utf8'), { schema }) as {
      insert?: { id: string; config: { plugins: { id: string; config?: { patches?: { id: string; config: Persona.Config }[] } }[] } }[]
    }[]
    const definition = rows.flatMap(row => row.insert ?? []).find(row => row.id === `preset-${profile}`)!
    const persona = definition.config.plugins.find(plugin => plugin.id === 'hivemind-chat-base')!
      .config!.patches!.find(patch => patch.id === 'persona')!.config
    const agent = await ctx.agentLoop.create(SessionId(`format-${profile}`), { provider: 'mock', model: 'mock' })
    await agent.ctx.plugin(Persona, persona)
    for (const [index, message] of messages.entries()) {
      agent.send(message, 'next-turn', true)
      await vi.waitFor(() => expect(adapter.requests).toHaveLength(index + 1))
      await vi.waitFor(() => expect(agent.status).toBe('idle'))
      const request = JSON.stringify(adapter.requests[index])
      expect(request).toContain('default to a saved HTML')
      expect(request).toContain('when the human explicitly requests it')
      expect(request).toContain('explicit final-format requirement authoritative')
      expect(request).not.toContain('justified delivery need')
      if (profile === 'hivemind-hq') {
        expect(request).toContain('After you actually inspect, accept and complete company work')
        expect(request).toContain('Reuse the same saved message_key, content and receipts')
      }
    }
    expect(JSON.stringify(adapter.requests.at(-1))).toContain('Please deliver the final customer report as PDF.')
  } finally { await ctx.fiber.dispose() }
})
