import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)),
  'utf8',
)

describe('HIVE composer layout', () => {
  it('keeps the native centered new-session hero geometry', () => {
    expect(css).toMatch(/\.root\[data-phase='hero'\] \.scrollBody\s*\{[^}]*justify-content:\s*center/s)
    expect(css).not.toMatch(/data-dsh-mode='hivemind-chat'[^}]*data-phase='hero'[^}]*justify-content:\s*flex-end/s)
  })

  it('keeps the native active composer bottom-docked', () => {
    expect(css).toMatch(/\.root\[data-phase='active'\] \.composerSeat\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0/s)
    expect(css).not.toMatch(/data-dsh-mode='hivemind-chat'[^}]*\.composerSeat\s*\{[^}]*transform:/s)
    expect(css).toMatch(/main:has\(\[data-conversation-scroll\]\)[\s\S]*height:\s*calc\(100vh - 56px\)/s)
  })

  it('keeps runtime disclosure icons and titles on the native inline row', () => {
    expect(css).toMatch(
      /data-dsh-mode='hivemind-chat'[\s\S]*\[data-disclosure-row\][^{}]*\{[^}]*display:\s*flex[^}]*align-items:\s*center/s,
    )
    expect(css).toMatch(
      /\[data-disclosure-row\][^{}]*> :first-child[^{}]*\{[^}]*display:\s*inline-flex[^}]*width:\s*calc\(16px/s,
    )
    expect(css).toMatch(
      /:first-child:has\(> :global\(span\)\)[^{}]*> :global\(svg\)[^{}]*\{[^}]*position:\s*absolute[^}]*opacity:\s*0/s,
    )
  })
})
