import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { expect, it } from 'vitest'
import { registerArtifactInspection } from '../src/artifact-inspection.ts'
import { ArtifactRenderer } from '../src/index.ts'

/** Real two-page PDF: red page 1, green page 2; each raster can be independently checked. */
function twoPagePdf(): Buffer {
  const streams = ['q 1 0 0 rg 0 0 200 200 re f Q', 'q 0 1 0 rg 0 0 200 200 re f Q']
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 6 0 R >>',
    ...streams.map(stream => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
  ]
  let text = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(text)
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  text += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  return Buffer.from(text + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}

class InspectionOnlyRenderer extends ArtifactRenderer {
  async render(): Promise<never> { throw new Error('Reader must never render a replacement artifact') }
}

async function fixture() {
  const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  const pdf = twoPagePdf()
  const file = { attachmentId: 'sha256:' + createHash('sha256').update(pdf).digest('hex'), name: 'saved-source.pdf', bytes: pdf.length } as FileAttachmentRef
  const images = new Map<string, Buffer>()
  let reads = 0
  ctx.provide('attachments', {
    async *readFileStream(ref: FileAttachmentRef, signal: AbortSignal) {
      signal.throwIfAborted(); reads++
      if (ref.attachmentId !== file.attachmentId || ref.bytes !== pdf.length) throw new Error('Native file integrity mismatch')
      yield pdf
    },
    async saveImage(input: { data: Uint8Array; mediaType: string; name: string }) {
      const bytes = Buffer.from(input.data), image = await loadImage(bytes)
      const attachmentId = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
      images.set(attachmentId, bytes)
      return { attachmentId, name: input.name, mediaType: input.mediaType, bytes: bytes.length,
        width: image.width, height: image.height } as ImageAttachmentRef
    },
  } as never)
  new InspectionOnlyRenderer(ctx)
  registerArtifactInspection(ctx)
  const agent = (events: unknown[]) => ({ session: { id: 'review-room', snapshotEvents: () => events } }) as unknown as Agent
  const received = { type: 'hivemind/room-message-received', data: { targetId: 'review-room', senderId: 'producer-room', artifactIds: ['saved-pdf'],
    artifacts: [{ artifactId: 'saved-pdf', producerSessionId: 'producer-room', file, mediaType: 'application/pdf' }] } }
  const run = (pdf_pages?: number[], events = [received], signal = new AbortController().signal, id = 'saved-pdf') => ctx.tools.execute({
    name: 'hivemind_artifact_inspect', arguments: { artifact_id: id, ...(pdf_pages === undefined ? {} : { pdf_pages }) },
    callId: ToolCallId('inspect-saved-pdf'), agent: agent(events), signal,
  })
  return { ctx, images, received, run, reads: () => reads }
}

it('defaults to the actual first PDF page and labels nonfirst and multiple selected page rasters', async () => {
  const f = await fixture()
  try {
    const first = await f.run()
    expect(first.isError).toBe(false)
    expect(JSON.stringify(first.content)).toContain('PDF has 2 pages; this call shows pages 1.')
    expect(first.content.filter(block => block.type === 'image')).toHaveLength(1)
    const second = await f.run([2])
    expect(second.isError).toBe(false)
    expect(JSON.stringify(second.content)).toContain('Saved PDF page 2 of 2')
    const multiple = await f.run([2, 1])
    expect(multiple.isError).toBe(false)
    expect(JSON.stringify(multiple.content)).toContain('this call shows pages 2, 1.')
    const labels = multiple.content.filter(block => block.type === 'text').map(block => block.text)
    expect(labels[1]).toContain('Saved PDF page 2 of 2'); expect(labels[2]).toContain('Saved PDF page 1 of 2')
    const previews = multiple.content.filter(block => block.type === 'image')
    expect(previews).toHaveLength(2)
    for (const [index, block] of previews.entries()) {
      if (!('attachment' in block) || !block.attachment) throw new Error('Expected native image attachment')
      const image = await loadImage(f.images.get(block.attachment.attachmentId)!)
      const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      expect([...context.getImageData(10, 10, 1, 1).data]).toEqual(index === 0 ? [0, 255, 0, 255] : [255, 0, 0, 255])
    }
  } finally { await f.ctx.fiber.dispose() }
})

it('keeps native PDF selection, range, file budget and cancellation bounds', async () => {
  const f = await fixture()
  try {
    for (const pages of [[], [0], [-1], [1.5], [1, 1], [1, 2, 3, 4, 5]]) {
      const result = await f.run(pages)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('one to four distinct positive page numbers')
    }
    expect(f.reads()).toBe(0)
    const outside = await f.run([3])
    expect(outside.isError).toBe(true)
    expect(JSON.stringify(outside.content)).toContain('outside the saved document')
    const large = { ...f.received, data: { ...f.received.data, artifacts: [{ ...f.received.data.artifacts[0]!,
      file: { ...f.received.data.artifacts[0]!.file, bytes: 50_000_001 } }] } }
    const oversized = await f.run([1], [large])
    expect(oversized.isError).toBe(true)
    expect(JSON.stringify(oversized.content)).toContain('bounded file size')
    expect(f.reads()).toBe(1)
    const abort = new AbortController(); abort.abort(new Error('caller canceled inspection'))
    const canceled = await f.run([2], [f.received], abort.signal)
    expect(canceled.isError).toBe(true)
    expect(canceled.error?.info).toMatchObject({ code: 'ABORTED_BEFORE_DISPATCH' })
    expect(f.reads()).toBe(1)
  } finally { await f.ctx.fiber.dispose() }
})

it('does not make selected pages authorize foreign receipts, prose, paths or non-PDF documents', async () => {
  const f = await fixture()
  try {
    for (const data of [
      { ...f.received.data, targetId: 'foreign-room' },
      { ...f.received.data, senderId: 'foreign-producer' },
      { ...f.received.data, artifactIds: [] },
    ]) {
      const result = await f.run([2], [{ ...f.received, data }])
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('receipt unavailable in this room')
    }
    for (const id of ['/tmp/saved-source.pdf', 'saved-source.pdf']) {
      const result = await f.run([2], [f.received], undefined, id)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('receipt unavailable in this room')
    }
    const html = { ...f.received, data: { ...f.received.data, artifacts: [{ ...f.received.data.artifacts[0]!, mediaType: 'text/html' }] } }
    expect(JSON.stringify((await f.run([1], [html])).content)).toContain('PDF page selection requires a saved PDF receipt')
    expect(f.reads()).toBe(0)
  } finally { await f.ctx.fiber.dispose() }
})
