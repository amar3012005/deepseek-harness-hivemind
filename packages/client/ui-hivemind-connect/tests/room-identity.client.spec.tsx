// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { roomIdentity } from '../src/client/room-identity.ts'
import { AgentChatAvatar } from '../src/client/AgentChatAvatar.tsx'
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
it('preserves the company hero mark while the room identity becomes ready', async () => {
  const previousPath = window.location.pathname
  window.history.replaceState({}, '', '/hivemind/app/employee/harness')
  let value = JSON.stringify(roomIdentity(undefined, undefined, true))
  const listeners = new Set<() => void>()
  const identity = { getSnapshot: () => value, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }
  const view = render(<RoomHeroMark identity={identity} />)
  expect(view.container.querySelector('[data-hivemind-hero-brand="singulance"]')).toBeTruthy()
  await act(async () => {
    value = JSON.stringify(roomIdentity('hivemind-hq', JSON.stringify({ id: null, slug: 'runtime', name: 'Runtime', role: 'AI Chief of Staff' })))
    listeners.forEach(listener => listener())
  })
  expect(view.container.querySelector('[data-hivemind-hero-brand="singulance"]')).toBeTruthy()
  window.history.replaceState({}, '', previousPath)
})

it('keeps the same employee color across own-room and incoming messages with top aligned portraits', async () => {
  const employee = { id: 'authorized-ravi', name: 'Ravi', role: 'Researcher' }
  const load = async () => [employee]
  const identity = { getSnapshot: () => JSON.stringify(employee), subscribe: () => () => {} }
  const view = render(<>
    <AgentChatAvatar identity={identity} load={load} />
    <AgentChatAvatar employeeId={employee.id} name={employee.name} load={load} />
  </>)
  await act(async () => { await Promise.resolve() })
  const portraits = view.container.querySelectorAll('[data-chat-agent-avatar]')
  expect(portraits.length).toBe(2)
  expect(portraits[0]?.getAttribute('data-chat-agent-color')).toBe(portraits[1]?.getAttribute('data-chat-agent-color'))
  expect((portraits[0] as HTMLElement).style.alignSelf).toBe('flex-start')
})
it('uses the same gray identity for Runtime own-room and incoming messages', async () => {
  const load = async () => []
  const view = render(<><AgentChatAvatar load={load} /><AgentChatAvatar employeeId="runtime" name="Runtime" load={load} /></>)
  await act(async () => { await Promise.resolve() })
  expect([...view.container.querySelectorAll('[data-chat-agent-avatar]')].map(node => node.getAttribute('data-chat-agent-color'))).toEqual(['runtime', 'runtime'])
})
