import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
const source = (file: string): string => readFileSync(new URL(`../src/client/skeleton/${file}`, import.meta.url), 'utf8')
it('shares the compact external Add-sheet bridge between phone Brain and employee routes', () => {
  const input = source('InputBar.tsx')
  expect(input).toContain("window.matchMedia('(max-width: 600px)').matches")
  expect(input).toContain('if (!isMobileLegacyChat() || locked || machineBusy) return')
  expect(input).toContain('hivemind:mobile-brain-add')
  expect(input).toContain('hivemind:mobile-brain-action')
  expect(input).toContain('if (!canAcceptDrop) return')
  expect(input).toContain('target.current?.click()')
  expect(input).toContain('else onToggleCommandMenu()')
})
it('preserves native voice, send, stop and hides dictation in mobile native chat', () => {
  const css = source('InputBar.module.css')
  expect(css).toContain(':global([data-native-chat]) :global([data-hivemind-dictation]) { display: none; }')
  expect(css).toContain(':global([data-native-chat]) .scroll { grid-column: 2; grid-row: 1;')
  expect(source('InputBar.tsx')).toContain('onClick={onPrimary}')
  expect(source('InputBar.tsx')).toContain('onClick={stop}')
  expect(source('InputBar.tsx')).toContain("renderSlot('conversation.input.right', {})")
})
it('removes only the message avatar marker and retains media', () => {
  const css = source('ConversationRoot.module.css')
  expect(css).toContain('.root[data-brain-chat] :global([data-chat-agent-avatar]) { display: none; }')
  expect(css).not.toContain('.root[data-brain-chat] img { display: none')
})

it('shares rounded black composer actions without removing native controls', () => {
  const css = source('InputBar.module.css')
  expect(css).toContain(':global([data-native-chat]) .primary { background: #0a0a0a; color: #fff; border-radius: 50%; }')
  expect(css).toContain(':global([data-native-chat]) .desktopOptions')
  expect(source('InputBar.tsx')).toContain("renderSlot('conversation.input.model', { locked: modelSeatLocked })")
})

it('extends only phone employee presentation while preserving images and voice', () => {
  const root = source('ConversationRoot.module.css')
  const phone = root.slice(root.indexOf('/* Employee phone rooms'))
  expect(phone).toContain('@media (max-width: 600px)')
  expect(phone).toContain('.root[data-agent-room] :global([data-chat-agent-avatar]) { display: none; }')
  expect(phone).not.toContain(' img { display: none')
  const input = source('InputBar.tsx')
  expect(input).toContain('employee\\/harness(?:\\/|$)')
  expect(input).toContain('hivemind:mobile-brain-action')
  expect(input).toContain('hivemind:mobile-connectors')
})
