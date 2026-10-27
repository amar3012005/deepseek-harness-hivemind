import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ScopeSelect.module.css', import.meta.url)), 'utf8')

describe('Brain phone tagline styles', () => {
  it('shows the Brain badge on phones over the global hero-badge hide rule', () => {
    expect(css).toMatch(/:global\(\[data-hivemind-hero-headline\] > span:last-child > span:last-child\) \{\s*display: none !important;/u)
    const phone = css.slice(css.lastIndexOf('@media (max-width: 600px)'))
    const badge = String.raw`:global\(\[data-brain-chat\] \[data-hivemind-brain-welcome\] > span:last-child > span:last-child\)`
    expect(phone).toMatch(new RegExp(badge + String.raw` \{ display: block !important; \}`, 'u'))
  })
})
