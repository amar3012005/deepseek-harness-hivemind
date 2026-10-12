/** Deterministic editable office files from compact, model-friendly source text. */
import ExcelJS from 'exceljs'
import type PptxGenJS from 'pptxgenjs'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { chromium } from 'playwright'
import type { GenerationProvider } from './generation.ts'
import { applyDesignProfile, evaluateDesignQuality } from './design-kit.ts'

/** Escape user text for a self-contained document. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

/** Editable XLSX; CSV cells stay literal so untrusted fields cannot become formulas. */
export const spreadsheetProvider: GenerationProvider = {
  id: 'exceljs', format: 'spreadsheet',
  instructions: 'Provide CSV with a header row. Quote fields containing commas or newlines. Cells are literal data; use the calculator for financial totals. Include units and sources as columns when relevant.',
  async generate(request) {
    request.signal.throwIfAborted()
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'HyperAgents'
    const sheet = await workbook.csv.read(Readable.from([request.content]), { map: value => String(value) })
    sheet.name = 'Data'
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183153' } }
    sheet.getRow(1).height = 26
    sheet.columns.forEach((column) => { column.width = 28; column.alignment = { vertical: 'top', wrapText: true } })
    if (sheet.columnCount > 0) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } }
    request.signal.throwIfAborted()
    return { data: new Uint8Array(await workbook.xlsx.writeBuffer()), extension: 'xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  },
}

/** Deterministic title/body slides preserve editable text and explicit sources. */
export const presentationProvider: GenerationProvider = {
  id: 'pptxgenjs', format: 'presentation',
  instructions: 'Provide Markdown: each # heading starts a slide; following lines are its body, including source URLs. Keep each slide concise. Produces an editable wide PPTX with consistent typography. Use PDF/HTML for bespoke brand layouts.',
  async generate(request) {
    request.signal.throwIfAborted()
    // The package's ESM export uses a .js extension without type:module.
    // Choose its supported CJS entry explicitly in the native Node loader.
    const Presentation = createRequire(import.meta.url)('pptxgenjs') as typeof PptxGenJS
    const deck = new Presentation()
    deck.layout = 'LAYOUT_WIDE'
    deck.author = 'HyperAgents'
    deck.subject = request.title
    deck.title = request.title
    const sections = request.content.split(/^# /m).filter(s => s.trim())
    for (const [index, section] of sections.entries()) {
      const [heading, ...lines] = section.trim().split('\n')
      const body = lines.join('\n').trim()
      if (body.length > 1800) throw new Error('A slide exceeds 1800 characters; split its content across slides')
      const slide = deck.addSlide()
      slide.background = { color: 'FAFBFC' }
      slide.addShape(deck.ShapeType.rect, { x: 0.55, y: 0.5, w: 0.08, h: 0.65, fill: { color: '183153' }, line: { color: '183153' } })
      slide.addText(heading ?? request.title, { x: 0.85, y: 0.5, w: 11.5, h: 0.8, fontFace: 'Aptos Display', fontSize: 29, bold: true, color: '14243B', breakLine: false, fit: 'shrink' })
      slide.addText(body, { x: 0.85, y: 1.65, w: 11.5, h: 4.65, fontFace: 'Aptos', fontSize: 21, color: '334155', paraSpaceAfter: 12, fit: 'shrink', valign: 'top' })
      slide.addText(`${request.title}  ·  ${index + 1}`, { x: 0.85, y: 6.85, w: 11.5, h: 0.25, fontSize: 10, color: '64748B' })
    }
    request.signal.throwIfAborted()
    const data = await deck.write({ outputType: 'nodebuffer' })
    return { data: new Uint8Array(data as Buffer), extension: 'pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
  },
}

/** Local HTML artifact. Publication remains a separate authenticated action. */
export const webProvider: GenerationProvider = {
  id: 'html-document', format: 'web',
  instructions: 'Provide complete HTML/CSS for an editable web artifact. It is saved locally, not deployed or published. Use source_format html and saved_image_ids with hive-asset:<attachment ID> placeholders for exact saved imagery. Use self-contained resources for the native screenshot preview. Optionally select a HIVE design_profile for a deterministic visual baseline; authored CSS can override it.',
  async generate(request) {
    request.signal.throwIfAborted()
    if (!/<html[\s>]/i.test(request.content)) throw new Error('Web content must be a complete HTML document')
    const html = applyDesignProfile(request.content, request.designProfile)
    const designQuality = evaluateDesignQuality(html, request.designProfile)
    const browser = await chromium.launch({ headless: true })
    const abort = () => { void browser.close().catch(() => undefined) }
    request.signal.addEventListener('abort', abort, { once: true })
    try {
      request.signal.throwIfAborted()
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1024 },
        deviceScaleFactor: 1,
        javaScriptEnabled: false,
        serviceWorkers: 'block',
      })
      // A preview is a local rendering operation, never a browser session.
      // Untrusted generated HTML cannot call a local service or fetch assets.
      await page.route('**/*', route => route.abort('blockedbyclient'))
      await page.setContent(html, { waitUntil: 'networkidle', timeout: 30_000 })
      await page.evaluate(() => document.fonts.ready)
      request.signal.throwIfAborted()
      const preview = request.htmlPdf === true ? undefined : await page.screenshot({ type: 'png', fullPage: false })
      const pdf = request.htmlPdf === true
        ? await page.pdf({ printBackground: true, preferCSSPageSize: true, format: 'A4' }) : undefined
      request.signal.throwIfAborted()
      return {
        data: pdf === undefined ? new TextEncoder().encode(html) : new Uint8Array(pdf),
        extension: pdf === undefined ? 'html' : 'pdf',
        mediaType: pdf === undefined ? 'text/html' : 'application/pdf',
        ...(preview === undefined ? {} : { preview: { data: new Uint8Array(preview), mediaType: 'image/png' as const, nameSuffix: '-preview.png' } }),
        designQuality,
      }
    } finally {
      request.signal.removeEventListener('abort', abort)
      await browser.close()
    }
  },
}

/** Preserve an already finished Markdown report verbatim, without a model rewrite. */
export const markdownReportProvider: GenerationProvider = {
  id: 'markdown-report', format: 'markdown_report', instructions: 'Provide the complete finished Markdown report. It is saved directly without another synthesis or rendering model call.',
  async generate(request) { return { data: new TextEncoder().encode(request.content), extension: 'md', mediaType: 'text/markdown' } },
}
