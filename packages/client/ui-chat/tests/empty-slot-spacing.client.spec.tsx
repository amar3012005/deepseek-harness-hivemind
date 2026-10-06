/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('collapses empty native keyed-slot anchors without hiding visible agent rows', () => {
  const wrapper = document.createElement('div')
  wrapper.dataset.agentRoom = ''
  const selector = '.flowItem:has(> [data-slot="conversation.chat.node"]:empty)'
  for (let index = 0; index < 20; index += 1) {
    const row = document.createElement('div'); row.className = 'flowItem'
    const anchor = document.createElement('div'); anchor.dataset.slot = 'conversation.chat.node'; anchor.style.display = 'contents'
    row.append(anchor); wrapper.append(row)
  }
  const visible = document.createElement('div'); visible.className = 'flowItem'
  visible.innerHTML = '<div data-slot="conversation.chat.node"><p>Here is the result.</p></div>'
  wrapper.append(visible)
  expect(wrapper.querySelectorAll(selector)).toHaveLength(20)
  expect(visible.matches(selector)).toBe(false)
  const css = readFileSync('packages/client/ui-chat/src/client/chat/ChatView.module.css', 'utf8')
  expect(css).toContain(":global([data-agent-room]) .flowItem:has(> :global([data-slot='conversation.chat.node']):empty)")
})
