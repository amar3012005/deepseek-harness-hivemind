// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { SendOutbox, type OutboxEntry } from '../src/client/sessions/send-outbox.ts'

function counterOutbox(): SendOutbox<string> {
  let next = 0
  return new SendOutbox<string>(() => `rpc-${++next}`)
}

describe('SendOutbox exactly-once', () => {
  it('mints one rpcId per message and keeps enqueue order', () => {
    const outbox = counterOutbox()
    const first = outbox.enqueue('one')
    const second = outbox.enqueue('two')
    expect(first.rpcId).toBe('rpc-1')
    expect(second.rpcId).toBe('rpc-2')
    expect(outbox.snapshot().map(entry => entry.payload)).toEqual(['one', 'two'])
  })

  it('sends each entry once within a connection, in order', async () => {
    const outbox = counterOutbox()
    outbox.enqueue('one')
    outbox.enqueue('two')
    outbox.beginConnection()
    const send = vi.fn(async (_entry: OutboxEntry<string>) => {})
    await outbox.flush(send)
    await outbox.flush(send)
    expect(send.mock.calls.map(([entry]) => entry.rpcId)).toEqual(['rpc-1', 'rpc-2'])
  })

  it('retries a failed send with the same rpcId, never a new one', async () => {
    const outbox = counterOutbox()
    outbox.enqueue('hello')
    outbox.beginConnection()
    const seen: string[] = []
    await outbox.flush(async (entry) => { seen.push(entry.rpcId); throw new Error('socket closed') })
    outbox.beginConnection()
    await outbox.flush(async (entry) => { seen.push(entry.rpcId) })
    expect(seen).toEqual(['rpc-1', 'rpc-1'])
  })

  it('removes an acknowledged entry and never sends it again, even after reconnect', async () => {
    const outbox = counterOutbox()
    outbox.enqueue('acked')
    outbox.enqueue('unacked')
    outbox.beginConnection()
    await outbox.flush(async () => {})
    expect(outbox.acknowledge('rpc-1')).toBe(true)
    outbox.beginConnection()
    const send = vi.fn(async (_entry: OutboxEntry<string>) => {})
    await outbox.flush(send)
    expect(send.mock.calls.map(([entry]) => entry.rpcId)).toEqual(['rpc-2'])
    expect(outbox.snapshot().map(entry => entry.rpcId)).toEqual(['rpc-2'])
  })

  it('does not double-send an in-flight entry when flush overlaps', async () => {
    const outbox = counterOutbox()
    outbox.enqueue('one')
    outbox.beginConnection()
    let release: () => void = () => {}
    const send = vi.fn((_entry: OutboxEntry<string>) => new Promise<void>((resolve) => { release = resolve }))
    const first = outbox.flush(send)
    const second = outbox.flush(send)
    release()
    await Promise.all([first, second])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not resend within the same connection after a successful send, before acknowledgement', async () => {
    const outbox = counterOutbox()
    outbox.enqueue('one')
    outbox.beginConnection()
    const send = vi.fn(async (_entry: OutboxEntry<string>) => {})
    await outbox.flush(send)
    await outbox.flush(send)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers on enqueue and acknowledgement', () => {
    const outbox = counterOutbox()
    const listener = vi.fn()
    const dispose = outbox.subscribe(listener)
    outbox.enqueue('x')
    outbox.acknowledge('rpc-1')
    expect(listener).toHaveBeenCalledTimes(2)
    dispose()
  })
})
