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
    expect(css).toMatch(/main:has\(\[data-conversation-scroll\]\)[\s\S]*height:\s*calc\(var\(--hm-app-viewport-height, 100vh\) - 56px\)/s)
  })

  it('aligns both HIVE modes and composer phases with the chat column', () => {
    expect(css).toMatch(/data-hivemind-harness-surface[^}]*\.composerSeat \.composerStack\s*\{[^}]*transform:\s*none\s*!important/s)
    // Embedded HIVE hides the header utilities; their controls live in the header corner.
    expect(css).toMatch(/\.root \.header \.headerUtilities\s*\{\s*display:\s*none;/u)
  })

  it('docks the Brain composer at the floor in the hero phase and keeps the greeting above it', () => {
    // The data-brain-chat marker sits on the host surface, so the rule scopes through an ancestor.
    // Before the first message the column packs to the floor and reserves room for the host footer.
    expect(css).toMatch(
      new RegExp(String.raw`:global\(\[data-brain-chat\]\) \.root\[data-phase='hero'\] \.scrollBody,[\s\S]*?\{\s*`
        + String.raw`justify-content:\s*flex-end;\s*padding-bottom:\s*calc\(var\(--hm-brain-composer-floor, 108px\)`, 'u'),
    )
    // No rule may grow the composer stack past the column, which pushed the composer below the fold.
    expect(css).not.toMatch(/\.composerSeat,[\s\S]*?flex:\s*1 0 auto/u)
  })

  it('keeps the Brain read-scope selector out of the phone row and never paints it empty', () => {
    expect(css).toMatch(/\.heroScope:empty\s*\{\s*display:\s*none/u)
    expect(css).toMatch(/@media \(max-width: 600px\)\s*\{\s*:global\(\[data-brain-chat\]\) \.heroScope\s*\{\s*display:\s*none/u)
  })

  it('does not paint an empty background strip above the Brain composer', () => {
    expect(css).not.toMatch(/\[data-brain-room\] \.heroWorkspaceRow\s*\{[^}]*background:/su)
  })

  it('keeps Chat and Trajectory as lower-left HIVE overlay controls', () => {
    const lowerLeft = new RegExp(
      String.raw`data-dsh-mode='hivemind-chat'[\s\S]*\.header:not\(\.headerHidden\)[^{]*\{`
      + String.raw`[^}]*position:\s*absolute[^}]*bottom:\s*18px[^}]*left:\s*18px`,
      's',
    )
    expect(css).toMatch(lowerLeft)
    expect(css).toMatch(
      /data-dsh-mode='hivemind-chat'[\s\S]*\.header \.titleRow\s*\{[^}]*display:\s*contents/s,
    )
    expect(css).toMatch(
      /data-dsh-mode='hivemind-chat'[\s\S]*\.header \.tabs\s*\{[^}]*pointer-events:\s*auto/s,
    )
    expect(css).not.toMatch(/data-dsh-mode='hivemind-chat'[^}]*\.root \.header\s*\{[^}]*display:\s*none/s)
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
