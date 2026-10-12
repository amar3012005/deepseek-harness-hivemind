import { Context } from '@deepseek-ai/cordis'
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { applyIndexInjections } from '../../../client/web/src/apply-injections.ts'
import { registerHivemindIndexInjections } from '../src/index-injections.ts'

// Native HMR's document-relative event endpoint.
const EVENTS_ROUTE = 'plugins/events'

describe('HIVE native index injections', () => {
  let context: Context | undefined
  afterEach(async () => { await context?.fiber.dispose() })

  it('roots served and authenticated boot resources at the app origin', async () => {
    context = new Context()
    registerHivemindIndexInjections(context, ['https://next.singulancelabs.com'])

    // The standalone route and authenticated /api/hivemind/boot collect the
    // same live injection event before rendering or returning its JSON rows.
    const preload: IndexInjection = { kind: 'html', placement: 'head', html: '<link rel="modulepreload" href="plugins/client.js">' }
    const bootInjections: IndexInjection[] = [preload]
    context.emit('webserver/index-inject', bootInjections)
    expect(bootInjections).toEqual([
      {
        kind: 'script', placement: 'head',
        text: "(()=>{let base=document.querySelector('base');if(!base){base=document.createElement('base');document.head.prepend(base)}base.setAttribute('href','/')})()",
      },
      preload,
      {
        kind: 'global',
        name: '__HIVEMIND_EMBED_CONFIG__',
        value: { version: 1, parentOrigins: ['https://next.singulancelabs.com'] },
      },
    ])

    const rendered = renderIndexInjections('<html><head></head><body></body></html>', bootInjections)
      // frontend-static prepends its generic base after rendering injection rows.
      .replace(/<head([^>]*)>/i, '<head$1><base href="./">')
    const nestedUrl = 'https://next.singulancelabs.com/hivemind/app/employee/harness/session/room-id'
    const servedDocument = new JSDOM(rendered, { url: nestedUrl, runScripts: 'dangerously' }).window.document
    expect(servedDocument.querySelector('base')?.getAttribute('href')).toBe('/')
    expect(new URL(EVENTS_ROUTE, servedDocument.baseURI).href).toBe('https://next.singulancelabs.com/plugins/events')
    expect(new URL('plugins/client.js', servedDocument.baseURI).href).toBe('https://next.singulancelabs.com/plugins/client.js')

    const bootDocument = new JSDOM('<html><head></head><body></body></html>', { url: nestedUrl, runScripts: 'dangerously' })
    const priorDocument = globalThis.document
    Object.defineProperty(globalThis, 'document', { configurable: true, value: bootDocument.window.document })
    try {
      await applyIndexInjections(bootInjections, async () => {})
      expect(bootDocument.window.document.querySelector('base')?.getAttribute('href')).toBe('/')
      expect(new URL(EVENTS_ROUTE, bootDocument.window.document.baseURI).href).toBe('https://next.singulancelabs.com/plugins/events')
    } finally {
      if (priorDocument === undefined) delete (globalThis as { document?: Document }).document
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: priorDocument })
      bootDocument.window.close()
    }
    servedDocument.defaultView?.close()
  })
})
