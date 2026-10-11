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

it('shares the embedded viewport axis and preserves mobile geometry and native view navigation', () => {
  const chat = readFileSync(new URL('../src/client/chat/ChatView.module.css', import.meta.url), 'utf8')
  const shell = readFileSync(new URL('../../ui-conversation/src/client/skeleton/ConversationRoot.module.css', import.meta.url), 'utf8')
  expect(chat).toContain('translateX(var(--hm-chat-center-offset, 0px))')
  expect(shell).toContain('translateX(var(--hm-chat-center-offset, 0px)) !important')
  expect(shell).toContain('--hm-chat-center-offset: max(')
  expect(chat).toContain('margin: 0; transform: none;')
  expect(shell).toMatch(/\.root\[data-agent-room\] \.composerViews\s*\{\s*display: block;/u)
})
