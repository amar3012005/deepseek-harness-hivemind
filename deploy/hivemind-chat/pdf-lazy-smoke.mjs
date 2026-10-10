import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve, extname } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { pdfFixture } from '../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'

const root = resolve(process.argv[2] ?? '/opt/deepseek-harness')
const require = createRequire(resolve(root, 'packages/hivemind/artifact-renderer/package.json'))
const { chromium } = require('playwright')
const shellPath = resolve(root, 'apps/web/dist/assets/harness-shell.js')
const shell = readFileSync(shellPath, 'utf8')
const ast = ts.createSourceFile('shell.js', shell, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
let seed
function findSeed(node) {
  if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property)
    && ts.isStringLiteral(property.name) && property.name.text === '@deepseek-ai/dsh-client-pdf-assets')) seed = node.getText(ast)
  ts.forEachChild(node, findSeed)
}
findSeed(ast)
if (!seed) throw new Error('Compiled shell omits PDF asset seed')
const preview = readFileSync(resolve(root, 'packages/client/ui-sidebar-documentpreview/lib/client.js'), 'utf8')
const previewAst = ts.createSourceFile('preview.js', preview, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
let offset
function findReturn(node) {
  if (ts.isReturnStatement(node) && node.expression?.getText(previewAst) === 'module.exports') offset = node.getStart(previewAst)
  ts.forEachChild(node, findReturn)
}
findReturn(previewAst)
if (offset === undefined) throw new Error('Compiled preview has no factory return')
const capture = preview.slice(0, offset) + 'window.__OPEN_PDF__ = openPdf;\n' + preview.slice(offset)
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://artifact.invalid').pathname
  try {
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<script>window.__DSH_EMBED_REQUEST__={cancelled:true}</script><script type="module" src="/assets/harness-shell.js"></script>')
    } else if (path === '/preview.js') {
      response.setHeader('Content-Type', 'text/javascript'); response.end(capture)
    } else {
      const file = resolve(root, 'apps/web/dist', '.' + path)
      if (!file.startsWith(resolve(root, 'apps/web/dist') + '/')) throw new Error('Invalid artifact path')
      response.setHeader('Content-Type', extname(file) === '.css' ? 'text/css' : 'text/javascript')
      response.end(file === shellPath ? shell + `\nwindow.__PDF_SEED__=${seed};` : readFileSync(file))
    }
  } catch { response.writeHead(404); response.end() }
})
await new Promise(ok => server.listen(0, '127.0.0.1', ok))
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors = [], resources = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname !== '127.0.0.1' && url.protocol !== 'blob:') throw new Error('PDF proof attempted external network')
    if (/\/resources-[^/]+\.js$/.test(url.pathname)) resources.push(url.pathname)
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => Boolean(window.__PDF_SEED__))
  if (resources.length) throw new Error('PDF binary resources loaded during shell startup')
  await page.evaluate(async () => {
    window.__ModuleLoader__ = { load: registration => registration.factory(specifier => {
      if (!(specifier in window.__PDF_SEED__)) throw Error('Missing actual shared dependency ' + specifier)
      return window.__PDF_SEED__[specifier]
    }) }
    await new Promise((ok, no) => { const script = document.createElement('script'); script.src = '/preview.js'; script.onload = ok; script.onerror = no; document.head.append(script) })
  })
  if (resources.length) throw new Error('PDF binary resources loaded when preview factory registered')
  const result = await page.evaluate(async bytes => {
    const session = window.__OPEN_PDF__(new Uint8Array(bytes), new AbortController().signal, error => { throw error })
    try {
      const pdf = await session.document
      const colors = []
      for (const number of [1, 2]) {
        const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 })
        const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height
        const context = canvas.getContext('2d')
        await page.render({ canvasContext: context, canvas, viewport }).promise
        colors.push(Array.from(context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data))
      }
      return { pages: pdf.numPages, colors }
    } finally { await session.dispose() }
  }, Array.from(pdfFixture()))
  if (result.pages !== 2 || result.colors[0][0] - result.colors[0][2] < 150 || result.colors[1][2] - result.colors[1][0] < 150) throw new Error('Real first-use PDF rendered wrong pages')
  if (resources.length !== 1 || errors.length) throw new Error('PDF resource/console acceptance failed: ' + JSON.stringify({ resources, errors }))
  console.log(JSON.stringify({ deferredAtStartup: true, deferredAtFactoryRegistration: true, firstUseResourceRequests: resources.length, realWorkerPages: result.pages, renderedColors: result.colors, pageErrors: errors }))
} finally { await browser.close(); await new Promise(ok => server.close(ok)) }
