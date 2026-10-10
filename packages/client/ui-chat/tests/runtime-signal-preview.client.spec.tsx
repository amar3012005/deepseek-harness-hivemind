// @vitest-environment jsdom
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { RuntimeSignalDetails, RuntimeSignalRow } from '../src/client/chat/RuntimeSignalRow.tsx'
import { runtimeSignal } from '../src/client/chat/runtime-signal.ts'
import css from '../src/client/chat/RuntimeSignalRow.module.css'

it('keeps fixed icons and wrapping context within the available desktop/mobile row', () => {
  let stylesheet = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/chat/RuntimeSignalRow.module.css'), 'utf8')
  expect(stylesheet).toMatch(/\.banner\s*\{[^}]*display: flex;[^}]*max-width: 100%;[^}]*min-width: 0;/s)
  expect(stylesheet).toMatch(/\.context\s*\{[^}]*flex: 1 1 0%;[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/s)
  expect(stylesheet).toContain('@media (max-width: 600px)')
  const example = (app: string, action: 'notify' | 'wake', preview: string, pending: boolean) => {
    const content = [{ type: 'text', text: 'Native admitted evidence:\n' + JSON.stringify({ app, evidence: { title: 'Team update', preview } }) }]
    const signal = runtimeSignal({ kind: 'hivemind-runtime-event', eventId: `${app}-${action}`, action, summary: `${app} update` }, content)!
    return renderToStaticMarkup(<section>
      <RuntimeSignalRow signal={signal} pending={pending} />
      {!pending && <RuntimeSignalDetails content={content} />}
    </section>)
  }
  // Explicit opt-in writes an inspectable local preview from the actual JSX and
  // CSS module. Ordinary CI runs only the layout contract assertions above.
  const previewPath = process.env['ATTENTION_BANNER_PREVIEW_PATH']
  if (previewPath === undefined) return
  const names = new Set([...stylesheet.matchAll(/\.([a-zA-Z][\w]*)/gu)].map(match => match[1]!))
  for (const name of names) stylesheet = stylesheet.replace(new RegExp(`\\.${name}\\b`, 'gu'), `.${css[name]}`)
  const markup = [
    example('slack', 'notify', 'The launch meeting moved to tomorrow. Keep the team’s preparation aligned.', true),
    example('gmail', 'wake', 'A customer is blocked on today’s delivery and needs a response.', true),
    example('slack', 'notify', 'The team agreed to focus on customer interviews this week.', false),
    example('dreaming', 'notify', 'Several recent conversations point to the same onboarding question.', true),
  ].join('')
  writeFileSync(previewPath, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Attention banner — local rendering preview</title><style>${stylesheet}body{margin:0;padding:24px;box-sizing:border-box;background:#fafafa;font-family:Arial,sans-serif}main{max-width:720px;margin:auto}h1{font-size:20px;margin:0 0 10px}p.preview-note{font-size:13px;color:#777;margin-bottom:24px}section{margin-bottom:20px}</style></head><body><main><h1>Attention updates</h1><p class="preview-note">Local component preview: notification, wake request, saved history, and logo fallback.</p>${markup}</main></body></html>`)
})
