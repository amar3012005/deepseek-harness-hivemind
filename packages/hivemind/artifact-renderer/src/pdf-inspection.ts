/** Inspect actual PDF bytes with bounded selected-page rasters. */
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'

export async function inspectPdf(data: Uint8Array, signal: AbortSignal, requireText = false, pages: readonly number[] = [1]) {
  signal.throwIfAborted()
  if (!pages.length || pages.length > 4 || new Set(pages).size !== pages.length ||
    pages.some(page => !Number.isSafeInteger(page) || page < 1)) {
    throw new Error('PDF inspection requires one to four distinct positive page numbers')
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const standardFontDataUrl = fileURLToPath(new URL('.', import.meta.resolve('pdfjs-dist/standard_fonts/FoxitSans.pfb')))
  const loading = getDocument({ data: new Uint8Array(data), useSystemFonts: false, standardFontDataUrl })
  const abort = () => { void loading.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const document = await loading.promise
    if (pages.some(page => page > document.numPages)) throw new Error('PDF inspection page is outside the saved document')
    const previews: { page: number; data: Uint8Array }[] = []
    for (const number of pages) {
      signal.throwIfAborted()
      const page = await document.getPage(number)
      if (requireText) {
        const text = await page.getTextContent()
        if (!text.items.some(item => 'str' in item && item.str.trim())) throw new Error('PDF rendering produced no readable text')
      }
      const base = page.getViewport({ scale: 1 })
      const view = page.getViewport({ scale: Math.min(1.5, 2048 / Math.max(base.width, base.height)) })
      const canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height))
      const task = page.render({ canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport: view })
      const cancel = () => { task.cancel() }
      signal.addEventListener('abort', cancel, { once: true })
      try { await task.promise } finally { signal.removeEventListener('abort', cancel) }
      previews.push({ page: number, data: await canvas.encode('png') })
    }
    signal.throwIfAborted()
    const first = previews[0]
    if (!first) throw new Error('PDF inspection returned no page')
    return { pageCount: document.numPages, preview: first.data, previews }
  } finally {
    signal.removeEventListener('abort', abort)
    await loading.destroy()
  }
}
