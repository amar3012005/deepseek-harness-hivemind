import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/chat/ReasoningRow.module.css', import.meta.url)),
  'utf8',
)

describe('ReasoningRow.module.css disclosure geometry', () => {
  it('lets the native disclosure own its height in collapsed and expanded states', () => {
    // A size-contained fixed-height wrapper can keep painting expanded content
    // while the following answer is laid out at the collapsed 24px boundary.
    expect(css).not.toMatch(/\.root:not\(\[data-expanded\]\)[^{]*\{[^}]*contain:\s*size\s+layout/s)
    expect(css).not.toMatch(/\.root:not\(\[data-expanded\]\)[^{]*\{[^}]*height:/s)
  })
})
