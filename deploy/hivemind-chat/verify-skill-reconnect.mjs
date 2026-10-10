import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'

const root = resolve(process.argv[2] ?? '/opt/deepseek-harness')
const require = createRequire(resolve(root, 'package.json'))
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
let plugin
const unhandled = []
const onUnhandled = error => unhandled.push(error)
process.on('unhandledRejection', onUnhandled)
try {
  dom.window.__ModuleLoader__ = { load: registration => {
    plugin = registration.factory(specifier => specifier === '@deepseek-ai/dsh-client-ui-primitives'
      ? { rankByName: rows => rows } : require(specifier))
  } }
  runInNewContext(readFileSync(resolve(root, 'packages/client/ui-skill/lib/client.js'), 'utf8'), {
    window: dom.window, document: dom.window.document, AbortController, console,
  })
  let source, calls = 0
  const handlers = new Map()
  const ctx = {
    effect: action => action(), get: () => ({ registerSource: value => { source = value; return () => {} } }),
    sessions: { subagentAddress: () => undefined },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (_name, action) => action(), register: () => () => {} },
    on: (name, handler) => handlers.set(name, handler),
    remote: { $on: () => {}, skills: { list: async (_request, signal) => {
      calls++
      if (calls === 1) return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Reconnect', 'AbortError')), { once: true })
      })
      if (calls === 3) throw new Error('real provider failure')
      return { ok: true, value: { skills: [{ name: 'artifact-check', description: 'Current generation', modelInvocable: true }] } }
    } } },
  }
  plugin.apply(ctx)
  const session = { sessionId: 'isolated-artifact-fixture' }
  const request = { query: '', signal: new AbortController().signal }
  const pending = source.candidates(session, request)
  handlers.get('connection/reset')()
  assert.equal((await pending).length, 0)
  assert.equal(source.lexicon(session), undefined)
  assert.equal((await source.candidates(session, request))[0].name, 'artifact-check')
  assert.equal(calls, 2)
  handlers.get('connection/reset')()
  await assert.rejects(source.candidates(session, request), /real provider failure/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(unhandled.length, 0)
  console.log('Compiled skill reconnect passed: cancelled generation settles, fresh generation retries, real failures remain visible; zero unhandled rejections')
} finally {
  process.off('unhandledRejection', onUnhandled)
  dom.window.close()
}
