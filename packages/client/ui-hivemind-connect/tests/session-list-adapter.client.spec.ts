import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { mainViewSessionId, projectedPreset } from '../src/client/session-list-adapter.ts'

const active = SessionId('active')
const retained = SessionId('retained')

it('follows native main-view retention when resolving the selected Session', () => {
  expect(mainViewSessionId({
    byId: {
      [active]: { id: active, retainedBy: { mainView: 1 } },
      [retained]: { id: retained, retainedBy: { mainView: 0 } },
    },
    projectionsBySession: {},
  })).toBe(active)
  expect(mainViewSessionId({ byId: {}, projectionsBySession: {} })).toBeUndefined()
})

it('prefers live projection values and falls back to the cached projection snapshot', () => {
  expect(projectedPreset({
    byId: { [active]: { id: active, retainedBy: {}, projectionValues: { agentPreset: 'live' } } },
    projectionsBySession: { [active]: { values: { agentPreset: 'cached' } } },
  }, active)).toBe('live')
  expect(projectedPreset({
    byId: { [active]: { id: active, retainedBy: {} } },
    projectionsBySession: { [active]: { values: { agentPreset: 'cached' } } },
  }, active)).toBe('cached')
  expect(projectedPreset({ byId: {}, projectionsBySession: {} }, undefined)).toBeUndefined()
})
