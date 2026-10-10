import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { transform } from 'lightningcss'

const { chromium } = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))('playwright')
const source = readFileSync(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url))
const compiled = transform({ filename: 'ConversationRoot.module.css', code: source, cssModules: true })
const c = name => compiled.exports[name].name

test('resolved phone rooms place input below the hero and above the usable bottom', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    for (const room of ['data-agent-room', 'data-brain-chat']) {
      for (const [width, height] of [[390, 844], [440, 956], [390, 500], [1024, 844]]) {
        await page.setViewportSize({ width, height })
        await page.setContent(`<!doctype html><html data-dsh-mode="hivemind-chat"><head><style>
          html,body{height:100%;margin:0} *{box-sizing:border-box}
          ${compiled.code.toString()}
          textarea{height:80px;width:100%}
        </style></head><body><div class="${c('root')}" data-native-chat ${room} data-phase="hero">
          <div class="${c('scrollBody')}"><div class="${c('composerSeat')}">
            <div class="${c('composerStack')} ${c('composerHero')}">
              <div class="${c('heroIntroduction')}"><h1>Your room</h1></div>
              <div class="${c('heroWorkspaceRow')}">Workspace</div>
              <div class="${c('composerInput')}"><textarea aria-label="Message"></textarea></div>
              <div class="${c('heroSuggestions')}"><button>Suggestion</button></div>
            </div></div></div></div></body></html>`)
        const input = page.getByRole('textbox', { name: 'Message' })
        await input.fill('Retained draft')
        const bounds = await input.boundingBox()
        assert.ok(bounds)
        if (width <= 600) {
          assert.ok(bounds.y + bounds.height <= height, `${room} input exceeds usable viewport`)
          assert.ok(height - bounds.y - bounds.height <= 12, `${room} input floats above usable bottom`)
          const suggestion = await page.getByRole('button', { name: 'Suggestion' }).boundingBox()
          assert.ok(suggestion.y + suggestion.height <= bounds.y, 'Suggestions must precede the phone input')
        } else {
          assert.ok(bounds.y > height / 4 && bounds.y < height * 3 / 4, 'Desktop hero remains centered')
        }
        assert.equal(await input.inputValue(), 'Retained draft')
      }
    }
  } finally { await browser.close() }
})
