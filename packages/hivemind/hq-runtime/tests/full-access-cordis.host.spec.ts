import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it } from 'vitest'
import { HqControl } from '../src/control.ts'
import { fullAccessState } from '../src/full-access.ts'
import { inject as runtimeInject } from '../../runtime/src/index.ts'

it('reproduces missing permission injection even when Full access is off', async () => {
  const root = new Context()
  await root.plugin({ name: 'native-permission-service', apply(ctx: Context) { ctx.provide('permissionPresets', { current: () => 'workspace-write' }) } })
  const fiber = await root.plugin({ name: 'missing-permission-dependency', apply() {} })
  const agent = { session: { ownEvents: () => [] } } as unknown as Agent
  try { expect(() => fullAccessState(fiber.ctx, agent)).toThrow('cannot get property "permissionPresets" without inject') }
  finally { await fiber.dispose() }
})

it('declares the permission service for both Runtime execution and HQ control', async () => {
  expect(runtimeInject).toContain('permissionPresets')
  expect(HqControl.inject).toContain('permissionPresets')
  const root = new Context()
  for (const name of HqControl.inject.filter(name => name !== 'permissionPresets')) root.provide(name, {})
  await root.plugin({ name: 'native-permission-service', apply(ctx: Context) { ctx.provide('permissionPresets', { current: () => 'workspace-write' }) } })
  const fiber = await root.plugin({ name: 'declared-permission-dependency', inject: HqControl.inject, apply() {} })
  const agent = { session: { ownEvents: () => [] } } as unknown as Agent
  try { expect(fullAccessState(fiber.ctx, agent)).toEqual({ enabled: false, revision: 0 }) }
  finally { await fiber.dispose() }
})
