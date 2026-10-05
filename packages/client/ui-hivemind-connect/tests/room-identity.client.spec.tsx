// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { roomIdentity } from '../src/client/room-identity.ts'
import { RoomHeroMark } from '../src/client/SingulanceMark.tsx'
afterEach(cleanup)
it('distinguishes pending first entry, saved Runtime owner and the employee identity', () => {
  expect(roomIdentity(undefined, undefined, true)).toMatchObject({ name: 'Runtime', pending: true })
  expect(roomIdentity('hivemind-hq', undefined)).toMatchObject({ pending: true })
  const owner = JSON.stringify({ id: null, slug: 'runtime', name: 'Runtime', role: 'AI Chief of Staff' })
  expect(roomIdentity('hivemind-hq', owner)).toEqual({ name: 'Runtime', role: 'AI Chief of Staff' })
  const ravi = JSON.stringify({ id: 'authorized-ravi', name: 'Ravi', role: 'Researcher' })
  expect(roomIdentity('hivemind-hyperagents', ravi)).toMatchObject({ name: 'Ravi', role: 'Researcher' })
  expect(roomIdentity('hivemind-chat', undefined)).toBeUndefined()
})
it('recognizes a legacy null-owner chief only after native HQ restoration', () => {
  const legacy = JSON.stringify({ id: null, slug: 'lead', name: 'Team Lead', role: 'generalist' })
  expect(roomIdentity('hivemind-hq', legacy)).toEqual({ name: 'Runtime', role: 'AI Chief of Staff' })
  expect(roomIdentity('hivemind-hyperagents', legacy)).toBeUndefined()
})
it('updates the first-entry portrait from the current room identity snapshot', async () => {
  let value = JSON.stringify(roomIdentity(undefined, undefined, true))
  const listeners = new Set<() => void>()
  const identity = { getSnapshot: () => value, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }
  const view = render(<RoomHeroMark identity={identity} />)
  expect(view.getByLabelText('Runtime, Opening our workspace…')).toBeTruthy()
  await act(async () => {
    value = JSON.stringify(roomIdentity('hivemind-hq', JSON.stringify({ id: null, slug: 'runtime', name: 'Runtime', role: 'AI Chief of Staff' })))
    listeners.forEach(listener => listener())
  })
  expect(view.queryByLabelText('Runtime, Opening our workspace…')).toBeNull()
  expect(view.getByLabelText('Runtime, AI Chief of Staff')).toBeTruthy()
})
