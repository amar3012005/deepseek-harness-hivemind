import { expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { inspectSavedImage, registerArtifactInspection, savedDocumentReference, readSavedText } from '../src/artifact-inspection.ts'

const png = createCanvas(4, 3).toBuffer('image/png')
const file = { attachmentId: 'immutable-file', name: 'saved.png', bytes: png.byteLength }
const agent = (events: unknown[]) => ({ session: { id: 'room', snapshotEvents: () => events } }) as unknown as Agent
const own = agent([{ type: 'hivemind/generation-created', data: { artifactId: 'saved', file, mediaType: 'image/png' } }])
const ctx = { attachments: { async *readFileStream() { yield png }, saveImage: async () => ({ attachmentId: 'pixel-preview', mediaType: 'image/png', bytes: png.byteLength, width: 4, height: 3 }) } } as unknown as Context
it('reads persisted image pixels without live jobs or tasks', async () => {
  expect(await inspectSavedImage(ctx, own, 'saved', new AbortController().signal)).toMatchObject({ attachmentId: 'pixel-preview', width: 4, height: 3 })
})
it('rejects foreign receipts, unaccepted transfers, oversized declarations and cancellation', async () => {
  await expect(inspectSavedImage(ctx, agent([]), 'saved', new AbortController().signal)).rejects.toThrow('receipt unavailable')
  const transfer = { type: 'hivemind/room-message-received', data: { targetId: 'other', senderId: 'producer', artifactIds: ['saved'], artifacts: [{ artifactId: 'saved', producerSessionId: 'producer', file }] } }
  await expect(inspectSavedImage(ctx, agent([transfer]), 'saved', new AbortController().signal)).rejects.toThrow('receipt unavailable')
  const oversized = agent([{ type: 'hivemind/generation-created', data: { artifactId: 'saved', file: { ...file, bytes: 31 * 1024 * 1024 }, mediaType: 'image/png' } }])
  await expect(inspectSavedImage(ctx, oversized, 'saved', new AbortController().signal)).rejects.toThrow('30 MiB')
  const abort = new AbortController(); abort.abort()
  await expect(inspectSavedImage(ctx, own, 'saved', abort.signal)).rejects.toThrow()
})
it('rejects changed bytes and accepts authorized transferred immutable files', async () => {
  const changed = { attachments: { ...ctx.attachments, async *readFileStream() { yield png.subarray(1) } } } as unknown as Context
  await expect(inspectSavedImage(changed, own, 'saved', new AbortController().signal)).rejects.toThrow('size mismatch')
  const transfer = agent([{ type: 'hivemind/room-message-received', data: { targetId: 'room', senderId: 'producer', artifactIds: ['saved'], artifacts: [{ artifactId: 'saved', producerSessionId: 'producer', file }] } }])
  expect(await inspectSavedImage(ctx, transfer, 'saved', new AbortController().signal)).toMatchObject({ attachmentId: 'pixel-preview' })
})

it('returns actual image attachment in the native model result', async () => {
  const native = new Context()
  await native.plugin(SystemPrompt); await native.plugin(ToolRuntime)
  native.provide('attachments', ctx.attachments)
  registerArtifactInspection(native)
  const result = await native.tools.execute({ name: 'hivemind_artifact_inspect', arguments: { artifact_id: 'saved' }, callId: ToolCallId('inspect-durable'), agent: own, signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(result.content).toContainEqual({ type: 'image', attachment: { attachmentId: 'pixel-preview', mediaType: 'image/png', bytes: png.byteLength, width: 4, height: 3 } })
  await native.fiber.dispose()
})

const html = '<!doctype html><html><body><h1>30-day customer acquisition</h1><p>Saved strategy, not a filename.</p></body></html>'
const documentFile = { attachmentId: 'shared-html-file', name: 'gtm.html', bytes: Buffer.byteLength(html) } as FileAttachmentRef
const received = { type: 'hivemind/room-message-received', data: { targetId: 'room', senderId: 'sofia-room', artifactIds: ['html-artifact'], artifacts: [{ artifactId: 'html-artifact', producerSessionId: 'sofia-room', mediaType: 'text/html', file: documentFile }] } }
it('reads exact shared HTML through native tool output without job or task', async () => {
  const native = new Context(); await native.plugin(SystemPrompt); await native.plugin(ToolRuntime)
  native.provide('attachments', { ...ctx.attachments, async *readFileStream() { yield Buffer.from(html) } })
  registerArtifactInspection(native)
  const result = await native.tools.execute({ name: 'hivemind_artifact_inspect', arguments: { artifact_id: 'html-artifact' }, callId: ToolCallId('inspect-shared-html'), agent: agent([received]), signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.content)).toContain(html)
  expect(result.content.some(part => part.type === 'image')).toBe(false)
  await native.fiber.dispose()
})
it('does not authorize another recipient, producer or non-member artifact ID', () => {
  for (const data of [
    { ...received.data, targetId: 'other-room' },
    { ...received.data, senderId: 'other-producer' },
    { ...received.data, artifactIds: ['other-id'] },
    { ...received.data, artifacts: [null] },
  ]) expect(savedDocumentReference(agent([{ ...received, data }]), 'html-artifact')).toBeUndefined()
  expect(savedDocumentReference(agent([received]), 'shared-html-file')).toMatchObject({ file: documentFile, mediaType: 'text/html' })
})
it('preserves text bounds, exact bytes, UTF-8 and cancellation', async () => {
  const textStore = { attachments: { async *readFileStream() { yield Buffer.from(html) } } } as unknown as Context
  await expect(readSavedText(textStore, { ...documentFile, bytes: 300_000 }, new AbortController().signal)).rejects.toThrow('256 KB')
  await expect(readSavedText(textStore, { ...documentFile, bytes: 1 }, new AbortController().signal)).rejects.toThrow('size mismatch')
  const abort = new AbortController(); abort.abort()
  await expect(readSavedText(textStore, documentFile, abort.signal)).rejects.toThrow()
  const invalid = { attachments: { async *readFileStream() { yield Uint8Array.from([255]) } } } as unknown as Context
  await expect(readSavedText(invalid, { ...documentFile, bytes: 1 }, new AbortController().signal)).rejects.toThrow()
})

it('recognizes native Markdown-PDF transfers whose producer event omits MIME', () => {
  const pdf = { ...received, data: { ...received.data, artifacts: [{ artifactId: 'html-artifact', producerSessionId: 'sofia-room', file: { ...documentFile, name: 'saved.pdf' } }] } }
  expect(savedDocumentReference(agent([pdf]), 'html-artifact')?.mediaType).toBe('application/pdf')
})
