import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Reject an overlay whose shell still seeds an older primitives namespace. */
export function verifySharedShell(primitives, shell) {
  const declaration = /export\s*\{([^}]+)\}\s*;/gu
  const names = [...primitives.matchAll(declaration)].flatMap(match => match[1].split(',')
    .map(entry => entry.trim().split(/\s+as\s+/u).at(-1)).filter(Boolean))
  if (names.length === 0) throw new Error('Shared primitives have no built export declaration')
  const missing = names.filter(name => !new RegExp(`\\b${name}\\s*:`,'u').test(shell))
  if (missing.length) throw new Error(`Shared shell is stale; missing primitives: ${missing.join(', ')}`)
  return names.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ?? '/opt/deepseek-harness'
  const count = verifySharedShell(
    readFileSync(resolve(root, 'packages/client/ui-primitives/lib/index.js'), 'utf8'),
    readFileSync(resolve(root, 'apps/web/dist/assets/harness-shell.js'), 'utf8'),
  )
  console.log(`Shared shell verified: ${count} primitives exports`)
}
