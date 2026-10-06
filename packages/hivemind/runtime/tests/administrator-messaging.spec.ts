import { it, expect } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { requireAdministratorMessageOwner } from '../src/administrator-messaging.ts'
function actor(preset: string, slug: string, parentSession?: string): Agent {
  return { session: { header: { agentPreset: preset, ...(parentSession ? { parentSession } : {}) }, snapshotEvents: () => [{ type: 'hivemind/session-owner', data: { id: slug === 'runtime' ? null : 'employee-id', slug, name: slug, role: 'Chief' } }] } } as unknown as Agent
}
it('admits only the persistent Runtime owner', () => {
  const runtime = actor('hivemind-hq', 'runtime')
  expect(requireAdministratorMessageOwner(runtime)).toBe(runtime)
  for (const invalid of [undefined, actor('hivemind-hyperagents', 'sofia'), actor('hivemind-hq', 'sofia'), actor('hivemind-hq', 'runtime', 'parent')]) expect(() => requireAdministratorMessageOwner(invalid)).toThrow()
})

it('uses the effective native preset without weakening owner or root checks', () => {
  const runtime = actor('hivemind-chat', 'runtime')
  const events = runtime.session.snapshotEvents()
  runtime.session.snapshotEvents = () => [...events, { type: 'agent-preset/selected', data: { agentPreset: 'hivemind-hq' } }] as never
  expect(requireAdministratorMessageOwner(runtime)).toBe(runtime)
  runtime.session.snapshotEvents = () => [...events, { type: 'agent-preset/selected', data: { agentPreset: 'hivemind-hyperagents' } }] as never
  expect(() => requireAdministratorMessageOwner(runtime)).toThrow()
})
