import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(
  new URL('../src/markdown/MarkdownText.module.css', import.meta.url),
), 'utf8')

describe('Markdown host reset isolation', () => {
  it('keeps link glyphs inline inside embedded product shells', () => {
    expect(css).toMatch(/\.linkIcon\s*\{[^}]*display:\s*inline-block/s)
  })

  it('restores unordered and ordered list markers locally', () => {
    expect(css).toMatch(/\.markdown ul\s*\{[^}]*list-style:\s*disc outside/s)
    expect(css).toMatch(/\.markdown ol\s*\{[^}]*list-style:\s*decimal outside/s)
  })
})
