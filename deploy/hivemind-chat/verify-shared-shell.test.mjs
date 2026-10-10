import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { verifySharedShell } from './verify-shared-shell.mjs'

test('rejects an older shell when plugins add a shared icon', () => {
  assert.throws(() => verifySharedShell('export { IconBellOutline16, Button };',
    'const namespace={Button:x};'), /missing primitives: IconBellOutline16/u)
})

test('accepts complete minified namespaces and aliased exports', () => {
  assert.equal(verifySharedShell('export { bell as IconBellOutline16, Button };',
    'const namespace={IconBellOutline16:a,Button:b};'), 2)
})

test('rejects missing libraries and incidental references outside the namespace', () => {
  assert.throws(() => verifySharedShell('', ''), /no built export/u)
  assert.throws(() => verifySharedShell('export { IconBellOutline16 };',
    'plugin.IconBellOutline16'), /Shared shell is stale/u)
})
