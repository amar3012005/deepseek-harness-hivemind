// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { pendingRuntimeSignals, runtimeSignal } from '../src/client/chat/runtime-signal.ts'
import { RuntimeSignalDetails, RuntimeSignalRow } from '../src/client/chat/RuntimeSignalRow.tsx'
import { ContextInjectionRow } from '../src/client/chat/ContextInjectionRow.tsx'

afterEach(cleanup)
const source = { kind: 'hivemind-runtime-event', eventId: 'event-one', action: 'notify', summary: 'Slack update' }
describe('Runtime signal admission presentation', () => {
  it('deduplicates retries and removes the queue echo after durable consumption', () => {
    const queue = [{ source }, { source }, { source: { kind: 'user' } }]
    expect(pendingRuntimeSignals(queue, new Set())).toHaveLength(1)
    expect(pendingRuntimeSignals(queue, new Set(['event-one']))).toEqual([])
    expect(runtimeSignal({ ...source, eventId: '' })).toBeNull()
  })
  it('does not claim a queued notify or requested wake is processing', () => {
    const signal = runtimeSignal(source)!
    const { rerender } = render(<RuntimeSignalRow signal={signal} pending />)
    expect(screen.getByRole('status', { name: 'Runtime notification' }).querySelector('[data-runtime-notification-bell] svg')).not.toBeNull()
    expect(screen.getByText('Queued for Runtime’s next turn')).toBeTruthy()
    rerender(<RuntimeSignalRow signal={{ ...signal, action: 'wake' }} pending />)
    expect(screen.getByText('Waiting for Runtime')).toBeTruthy()
    expect(screen.queryByText(/processing/i)).toBeNull()
    rerender(<RuntimeSignalRow signal={signal} pending={false} />)
    expect(screen.getByText('Received by Runtime')).toBeTruthy()
  })
  it('shows safe evidence fields without exposing the connector envelope', () => {
    render(<RuntimeSignalDetails content={[{ type: 'text', text: JSON.stringify({ evidence: { title: 'New request', preview: 'A team update' }, authenticatedActor: 'private-actor', raw: 'private-envelope' }) }]} />)
    expect(screen.getByText('New request')).toBeTruthy()
    expect(screen.getByText('A team update')).toBeTruthy()
    expect(screen.queryByText(/private-/)).toBeNull()
  })
  it('keeps consumed Runtime events visible in Brain where ordinary injections are hidden', () => {
    document.documentElement.dataset.dshMode = 'hivemind-chat'
    render(<ContextInjectionRow source={source as never} content={[{ type: 'text', text: '{"evidence":{"preview":"New team update"}}' }]}
      provenance={{ role: 'plugin', label: 'Runtime' } as never} form="notice" t={((key: string) => key) as never} />)
    expect(screen.getByText('Received by Runtime')).toBeTruthy()
    expect(screen.getByText('New team update')).toBeTruthy()
    delete document.documentElement.dataset.dshMode
  })
})
