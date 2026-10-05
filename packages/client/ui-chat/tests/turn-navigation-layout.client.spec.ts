import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps the agent jump rail on the native conversation left edge at narrow widths', () => {
  const css = readFileSync(new URL('../src/client/chat/TurnNavigator.module.css', import.meta.url), 'utf8')
  const narrow = css.indexOf('@container (max-width: 900px)')
  const agentRule = css.indexOf(':global([data-agent-room]) .slot')
  expect(agentRule).toBeGreaterThan(narrow)
  expect(css.slice(agentRule)).toContain('display: block;')
  expect(css).toMatch(/\[data-agent-room\]\) \.frame\s*\{\s*left:/u)
  expect(css).toMatch(/\[data-agent-room\]\) \.preview\s*\{\s*left: calc\(100% \+ 10px\);/u)
  expect(css.slice(agentRule)).not.toContain('opacity: 0')
})
