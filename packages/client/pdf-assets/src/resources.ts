/** Build-owned worker and exact-name resources; no external resource fallback. */
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'
export { workerSource }
export type PdfAssetMap = Readonly<Record<'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl', Readonly<Record<string, string>>>>
declare const __DSH_PDFJS_ASSETS__: PdfAssetMap
export const assets = __DSH_PDFJS_ASSETS__
