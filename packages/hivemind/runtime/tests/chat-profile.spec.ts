import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isHiveChat } from '../src/chat-profile.ts'
const actor = (preset: string, selected?: string) => ({ session: {
  header: { agentPreset: preset }, snapshotEvents: () => selected === undefined ? []
    : [{ type: 'agent-preset/selected', data: { agentPreset: selected } }],
} }) as unknown as Agent

describe('Brain identity isolation', () => {
  it('keeps Brain scoped to its native preset', () => {
    expect(isHiveChat(actor('hivemind-chat'))).toBe(true)
    expect(isHiveChat(actor('hivemind-hq'))).toBe(false)
    expect(isHiveChat(actor('hivemind-hyperagents'))).toBe(false)
  })
  it('uses the latest saved selection rather than a stale header', () => {
    expect(isHiveChat(actor('hivemind-chat', 'hivemind-hq'))).toBe(false)
    expect(isHiveChat(actor('hivemind-hq', 'hivemind-chat'))).toBe(true)
  })
})
