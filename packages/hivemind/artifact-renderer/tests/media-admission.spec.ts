import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MediaAdmission, acquireMediaAdmission, type MediaOwner } from '../src/media-admission.ts'

const owner = (orgId = 'org-a', userId = 'user-a', sessionId = 'session-a'): MediaOwner => ({ orgId, userId, sessionId })
function fixture(limit = 50) {
  const root = mkdtempSync(join(tmpdir(), 'media-admission-'))
  const config = { path: join(root, 'ledger.sqlite'), globalConcurrency: 2, tenantConcurrency: 1, maxQueued: 3, dailyUserLimit: limit }
  const queue = new MediaAdmission(config)
  return { root, config, queue, dispose: () => { queue.close(); rmSync(root, { recursive: true, force: true }) } }
}
describe('authenticated durable media admission', () => {
  it('shares one admission policy across chat and HyperAgent session mounts', async () => {
    const f = fixture()
    const chat = acquireMediaAdmission(f.config); const hyperagent = acquireMediaAdmission(f.config)
    try {
      expect(chat.queue).toBe(hyperagent.queue)
      chat.queue.reserve(owner(), 'chat')
      hyperagent.queue.reserve(owner(), 'hyperagent')
      const release = await chat.queue.acquire(owner(), 'chat', new AbortController().signal)
      let started = false
      const pending = hyperagent.queue.acquire(owner(), 'hyperagent', new AbortController().signal).then((done) => { started = true; return done })
      await Promise.resolve(); expect(started).toBe(false)
      release(); (await pending)()
      chat.release(); hyperagent.queue.reserve(owner('org-b'), 'after-chat-close')
    } finally { chat.release(); hyperagent.release(); f.dispose() }
  })
  it('rejects cross-org, cross-user and cross-session operation reuse', () => {
    const f = fixture()
    try {
      f.queue.reserve(owner(), 'operation')
      for (const intruder of [owner('org-b'), owner('org-a', 'user-b'), owner('org-a', 'user-a', 'session-b')]) {
        expect(() => f.queue.reserve(intruder, 'operation')).toThrow('ownership mismatch')
        expect(() => f.queue.status(intruder, 'operation')).toThrow('ownership mismatch')
      }
    } finally { f.dispose() }
  })
  it('persists quota and charges an idempotent operation only once across reopen', () => {
    const f = fixture(1)
    try {
      f.queue.reserve(owner(), 'one'); f.queue.reserve(owner(), 'one'); f.queue.close()
      const restored = new MediaAdmission(f.config)
      try {
        restored.reserve(owner(), 'one')
        expect(() => restored.reserve(owner(), 'two')).toThrow('daily allowance')
        restored.reserve(owner('org-b'), 'other-tenant')
      } finally { restored.close() }
    } finally { f.dispose() }
  })
  it('admits another tenant while one tenant waits and releases slots exactly once', async () => {
    const f = fixture(); const signal = new AbortController().signal
    try {
      for (const [id, who] of [['a1', owner()], ['a2', owner()], ['b', owner('org-b')]] as const) f.queue.reserve(who, id)
      const releaseA = await f.queue.acquire(owner(), 'a1', signal)
      let started = false
      const next = f.queue.acquire(owner(), 'a2', signal).then((release) => { started = true; return release })
      const releaseB = await f.queue.acquire(owner('org-b'), 'b', signal)
      expect(started).toBe(false); expect(f.queue.status(owner(), 'a2')).toBe('queued')
      releaseA(); releaseA(); const releaseNext = await next
      expect(started).toBe(true); releaseNext(); releaseB()
    } finally { f.dispose() }
  })
  it('cancels queued work without dispatch and drains safely on shutdown', async () => {
    const f = fixture(); const cancel = new AbortController()
    try {
      f.queue.reserve(owner(), 'active'); f.queue.reserve(owner(), 'waiting')
      const release = await f.queue.acquire(owner(), 'active', new AbortController().signal)
      const waiting = f.queue.acquire(owner(), 'waiting', cancel.signal)
      const assertion = expect(waiting).rejects.toThrow('cancelled')
      cancel.abort(); await assertion
      expect(f.queue.status(owner(), 'waiting')).toBe('queued')
      f.queue.close(); f.queue.finish('active', 'killed'); release(); release()
      await expect(f.queue.acquire(owner(), 'new', new AbortController().signal)).rejects.toThrow('stopping')
    } finally { f.dispose() }
  })
  it('rejects duplicate live admission', async () => {
    const f = fixture(); const signal = new AbortController().signal
    try {
      f.queue.reserve(owner(), 'same'); const release = await f.queue.acquire(owner(), 'same', signal)
      await expect(f.queue.acquire(owner(), 'same', signal)).rejects.toThrow('already admitted')
      release()
    } finally { f.dispose() }
  })
})
