// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  adoptHostDraft, configureHostDraftParentOrigins, hostDraftParentOrigins, hostDraftRoomKey, listenForHostDrafts,
  mergeHandoffDraft, readPendingDraft, subscribePendingDrafts, takePendingDraft, writePendingDraft,
} from '../src/client/skeleton/pending-draft.ts'

const a = 'session-a' as SessionId
const b = 'session-b' as SessionId

afterEach(() => {
  takePendingDraft(a)
  takePendingDraft(b)
})

describe('pending composer buffer', () => {
  it('keeps typed text per Session and never leaks it across Sessions', () => {
    writePendingDraft(a, 'draft for a')
    expect(readPendingDraft(a)).toBe('draft for a')
    expect(readPendingDraft(b)).toBe('')
  })

  it('takes the text exactly once; a second take returns nothing', () => {
    writePendingDraft(a, 'hello')
    expect(takePendingDraft(a)).toBe('hello')
    expect(takePendingDraft(a)).toBe('')
    expect(readPendingDraft(a)).toBe('')
  })

  it('clears the buffer when the text is emptied', () => {
    writePendingDraft(a, 'typed')
    writePendingDraft(a, '')
    expect(readPendingDraft(a)).toBe('')
  })

  it('notifies subscribers on write and take, and stops after disposal', () => {
    const listener = vi.fn()
    const dispose = subscribePendingDrafts(listener)
    writePendingDraft(a, 'x')
    takePendingDraft(a)
    expect(listener).toHaveBeenCalledTimes(2)
    dispose()
    writePendingDraft(a, 'y')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not notify when a take finds nothing', () => {
    const listener = vi.fn()
    const dispose = subscribePendingDrafts(listener)
    takePendingDraft(a)
    expect(listener).not.toHaveBeenCalled()
    dispose()
  })
})

describe('mergeHandoffDraft', () => {
  it('adopts the buffered text when the machine draft is empty', () => {
    expect(mergeHandoffDraft('', 'typed early')).toBe('typed early')
    expect(mergeHandoffDraft('   ', 'typed early')).toBe('typed early')
  })

  it('keeps the machine draft when nothing was buffered', () => {
    expect(mergeHandoffDraft('machine text', '')).toBe('machine text')
  })

  it('appends buffered text after a non-empty machine draft so neither is lost', () => {
    expect(mergeHandoffDraft('machine text', 'typed early')).toBe('machine text\ntyped early')
  })
})

describe('host draft handoff', () => {
  it('adopts host text once, only when the buffer and machine draft are empty', () => {
    expect(adoptHostDraft(a, 'from host', '')).toBe(true)
    expect(readPendingDraft(a)).toBe('from host')
    expect(adoptHostDraft(a, 'second', '')).toBe(false)
    expect(readPendingDraft(a)).toBe('from host')
    expect(adoptHostDraft(b, 'blocked', 'machine text')).toBe(false)
    expect(readPendingDraft(b)).toBe('')
  })

  it('ignores blank host text', () => {
    expect(adoptHostDraft(a, '   ', '')).toBe(false)
    expect(readPendingDraft(a)).toBe('')
  })

  it('maps routes to the host room key and ignores other routes', () => {
    expect(hostDraftRoomKey('/hivemind/app/employee/dots/employee/abc')).toBe('runtime')
    expect(hostDraftRoomKey('/hivemind/app/overview/new')).toBe('brain')
    expect(hostDraftRoomKey('/hivemind/app/brain')).toBe('brain')
    expect(hostDraftRoomKey('/settings')).toBeUndefined()
  })

  it('accepts messages from the same origin and allow-listed parents for this room only', () => {
    let listener: ((event: MessageEvent) => void) | undefined
    const source = {
      addEventListener: (_type: 'message', fn: (event: MessageEvent) => void) => { listener = fn },
      removeEventListener: vi.fn(),
    }
    const dispose = listenForHostDrafts(source, {
      selfOrigin: 'https://runtime.example',
      allowedParentOrigins: ['https://host.example'],
      roomId: 'runtime',
      sessionId: a,
      machineDraft: () => '',
    })
    const send = (origin: string, data: unknown) => listener?.({ origin, data } as MessageEvent)

    send('https://evil.example', { type: 'hm:composer-draft', roomId: 'runtime', text: 'nope' })
    expect(readPendingDraft(a)).toBe('')

    send('https://host.example', { type: 'hm:composer-draft', roomId: 'brain', text: 'other room' })
    expect(readPendingDraft(a)).toBe('')

    send('https://host.example', { type: 'other', roomId: 'runtime', text: 'wrong type' })
    expect(readPendingDraft(a)).toBe('')

    send('https://host.example', { type: 'hm:composer-draft', roomId: 'runtime', text: 'adopted' })
    expect(readPendingDraft(a)).toBe('adopted')

    send('https://runtime.example', { type: 'hm:composer-draft', roomId: 'runtime', text: 'second' })
    expect(readPendingDraft(a)).toBe('adopted')

    dispose()
    expect(source.removeEventListener).toHaveBeenCalledTimes(1)
  })
})

describe('host draft parent origin config', () => {
  it('accepts exact origins and publishes them', () => {
    configureHostDraftParentOrigins(['https://next.singulancelabs.com'])
    expect(hostDraftParentOrigins()).toEqual(['https://next.singulancelabs.com'])
    configureHostDraftParentOrigins([])
  })

  it('fails loud on an origin with a path, a trailing slash, or a non-URL value', () => {
    expect(() => { configureHostDraftParentOrigins(['https://next.singulancelabs.com/app']) }).toThrow(/exact origin/)
    expect(() => { configureHostDraftParentOrigins(['https://next.singulancelabs.com/']) }).toThrow(/exact origin/)
    expect(() => { configureHostDraftParentOrigins(['not a url']) }).toThrow(/invalid host draft parent origin/)
  })
})
