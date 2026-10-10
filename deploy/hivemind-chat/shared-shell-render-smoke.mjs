import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createContext, SourceTextModule, runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

const root = resolve(process.argv[2] ?? '/opt/deepseek-harness')
const entry = resolve(root, 'apps/web/dist/assets/harness-shell.js')
const code = readFileSync(entry, 'utf8')
const program = ts.createSourceFile('shell.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
let seed
function findSeed(node) {
  if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property)
    && ts.isStringLiteral(property.name) && property.name.text === '@deepseek-ai/dsh-client-ui-primitives')) seed = node.getText(program)
  ts.forEachChild(node, findSeed)
}
findSeed(program)
if (!seed) throw new Error('Shell has no shared seed table')
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://artifact.invalid' })
const context = createContext({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  MutationObserver: dom.window.MutationObserver, console, setTimeout, clearTimeout,
  URL, AbortController, AbortSignal, TextEncoder, TextDecoder,
  fetch: () => { throw new Error('Artifact smoke must not use network') },
})
dom.window.__DSH_EMBED_REQUEST__ = { cancelled: true }
const modules = new Map()
async function load(path, capture = false) {
  if (modules.has(path)) return modules.get(path)
  const module = new SourceTextModule(readFileSync(path, 'utf8')
    + (capture ? `\nglobalThis.__SHARED_SEED__ = ${seed};` : ''), { context, identifier: path })
  modules.set(path, module)
  await module.link((specifier, importer) => load(resolve(dirname(importer.identifier), specifier)))
  return module
}
try {
  await (await load(entry, true)).evaluate()
  const shared = context.__SHARED_SEED__
  const primitives = shared['@deepseek-ai/dsh-client-ui-primitives']
  // Use the actual shell renderer and React identity. A Node SSR renderer
  // owns a different dispatcher and cannot render hook-bearing shell components.
  const react = shared.react
  const reactDom = shared['react-dom']
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const renderRoot = shared['react-dom/client'].createRoot(container)
  const render = (component, props) => {
    reactDom.flushSync(() => renderRoot.render(react.createElement(component, props)))
    return container.innerHTML
  }
  const svg = render(primitives.IconBellOutline16)
  if (!svg.includes('<svg') || !svg.includes('<path')) throw new Error('Compiled bell did not render')
  // Capture the existing compiled renderer inside its closure, leaving shipped bytes unchanged.
  const plugin = readFileSync(resolve(root, 'packages/client/ui-chat/lib/client.js'), 'utf8')
  const ast = ts.createSourceFile('chat.js', plugin, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let returnOffset
  function findReturn(node) {
    if (ts.isReturnStatement(node) && node.expression?.getText(ast) === 'module.exports') returnOffset = node.getStart(ast)
    ts.forEachChild(node, findReturn)
  }
  findReturn(ast)
  if (returnOffset === undefined) throw new Error('Chat has no closure export return')
  dom.window.__ModuleLoader__ = { load: registration => registration.factory(specifier => {
    if (!(specifier in shared)) throw new Error(`Unseeded chat external: ${specifier}`)
    return shared[specifier]
  }) }
  runInContext(plugin.slice(0, returnOffset) + 'globalThis.__SIGNAL_RENDERER__ = RuntimeSignalRow;\n'
    + plugin.slice(returnOffset), context)
  const html = render(context.__SIGNAL_RENDERER__, {
    signal: { eventId: 'artifact-check', action: 'notify', summary: 'Artifact check', appName: 'Slack',
      logoUrl: 'https://artifact.invalid/slack.svg' }, pending: false,
  })
  if (!html.includes('data-runtime-notification-bell') || !html.includes('<svg')) throw new Error('Compiled notification omitted bell')
  if (!html.includes('Slack') || !html.includes('Artifact check')) throw new Error('Compiled notification omitted app context')
  if (!dom.window.document.querySelector('style[data-plugin-css$="/RuntimeSignalRow.module.css"]')) {
    throw new Error('Compiled notification omitted responsive stylesheet')
  }
  const logo = container.querySelector('img')
  if (!logo) throw new Error('Compiled notification omitted logo')
  reactDom.flushSync(() => logo.dispatchEvent(new dom.window.Event('error')))
  if (container.querySelector('img') || !container.querySelector('[data-runtime-signal-logo]')?.textContent.includes('S')) {
    throw new Error('Compiled notification logo fallback did not update through shared React')
  }
  reactDom.flushSync(() => renderRoot.unmount())
  console.log('Compiled shared React bell, attention context, stylesheet, and logo-hook fallback passed; zero network requests')
} finally { dom.window.close() }
