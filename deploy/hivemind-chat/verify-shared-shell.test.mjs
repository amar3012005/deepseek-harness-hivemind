import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { verifySharedShell } from './verify-shared-shell.mjs'

test('rejects an older shell when plugins add a shared icon', () => {
  assert.throws(() => verifySharedShell('export { IconBellOutline16, Button };',
    'const namespace={Button:x}; const seed={"@deepseek-ai/dsh-client-ui-primitives":namespace};'), /missing primitives: IconBellOutline16/u)
})

test('accepts complete minified namespaces and aliased exports', () => {
  assert.equal(verifySharedShell('export { bell as IconBellOutline16, Button };',
    'const namespace=Object.freeze({IconBellOutline16:a,Button:b}); const seed={"@deepseek-ai/dsh-client-ui-primitives":namespace};'), 2)
})

test('rejects missing libraries and incidental references outside the namespace', () => {
  assert.throws(() => verifySharedShell('', ''), /no built export/u)
  assert.throws(() => verifySharedShell('export { IconBellOutline16 };',
    'const namespace={Button:b}; const seed={"@deepseek-ai/dsh-client-ui-primitives":namespace}; plugin.IconBellOutline16'), /Shared shell is stale/u)
})
