import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import HivemindExecutionScope from '../../execution-scope/src/index.ts'
import { HqControl } from '../src/control.ts'

/** Exercise the actual decorated control method under Cordis dependency isolation. */
async function scopedControl(inject: string[]) {
  const root = new Context()
  await root.plugin(HivemindExecutionScope)
  for (const name of HqControl.inject.filter(name => name !== 'hivemindExecutionScope')) root.provide(name, {})
  const fiber = await root.plugin({ name: 'tour-native-context-test', inject, apply() {} })
  const agent = { id: 'isolated-runtime', status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    session: { snapshotEvents: () => [] } } as unknown as Agent
  const control = Object.assign(Object.create(HqControl.prototype), { ctx: fiber.ctx, root: () => agent }) as HqControl
  return { root, fiber, agent, control }
}

describe('Runtime tour native Cordis dependency boundary', () => {
  it('reproduces the deployed missing-inject rejection with an authenticated principal', async () => {
    const f = await scopedControl(HqControl.inject.filter(name => name !== 'hivemindExecutionScope'))
    try {
      expect(() => f.root.hivemindExecutionScope.run({ orgId: 'fixture-org', userId: 'fixture-admin',
        profile: 'hivemind-chat', variation: 'fixture' }, () => f.control.tourState(f.agent)))
        .toThrow('cannot get property "hivemindExecutionScope" without inject')
    } finally { await f.fiber.dispose() }
  })
  it('reads sleeping state through the actual control dependency declaration', async () => {
    const f = await scopedControl(HqControl.inject)
    try {
      expect(f.root.hivemindExecutionScope.run({ orgId: 'fixture-org', userId: 'fixture-admin',
        profile: 'hivemind-chat', variation: 'fixture' }, () => f.control.tourState(f.agent)))
        .toMatchObject({ awakening: 'sleeping', version: 1, canResume: false })
    } finally { await f.fiber.dispose() }
  })
  it('continues to reject tour reads outside authenticated execution scope', async () => {
    const f = await scopedControl([...HqControl.inject, 'hivemindExecutionScope'])
    try { expect(() => f.control.tourState(f.agent)).toThrow('hivemind execution scope is unavailable') }
    finally { await f.fiber.dispose() }
  })
  it('recognizes an already awakened room through the real Cordis context', async () => {
    const f = await scopedControl(HqControl.inject)
    try {
      f.agent.session.snapshotEvents = () => [
        { seq: SessionSeq(1), time: 0, type: 'hivemind/hq-awakening-start', data: { version: 1, turn: 1, startedAt: '2026-10-08T00:00:00Z' } },
        { seq: SessionSeq(2), time: 0, type: 'hivemind/hq-awakening-checkpoint', data: { stage: 'conversation', turn: 1,
          summary: 'Confirmed initial conversation', receiptSeqs: [], blocked: false, recordedAt: '2026-10-08T00:00:01Z', cards: [] } },
      ]
      expect(f.root.hivemindExecutionScope.run({ orgId: 'fixture-org', userId: 'fixture-admin',
        profile: 'hivemind-chat', variation: 'fixture' }, () => f.control.tourState(f.agent)))
        .toMatchObject({ awakening: 'awakened', canResume: false })
    } finally { await f.fiber.dispose() }
  })
})
