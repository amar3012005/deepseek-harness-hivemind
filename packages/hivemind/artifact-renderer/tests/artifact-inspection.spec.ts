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
it('reads exact native owner-uploaded text without exposing host filesystem access', async () => {
  const file = { attachmentId:'owner-checklist',name:'checklist.md',bytes:Buffer.byteLength(html) } as FileAttachmentRef
  const uploaded = { type:'user/message',data:{ source:{ kind:'user' },content:[{ type:'file',attachment:file }] } }
  const native = new Context(); await native.plugin(SystemPrompt); await native.plugin(ToolRuntime)
  native.provide('attachments', { ...ctx.attachments, async *readFileStream() { yield Buffer.from(html) } })
  registerArtifactInspection(native)
  const result = await native.tools.execute({ name:'hivemind_artifact_inspect',arguments:{ artifact_id:file.attachmentId },
    callId:ToolCallId('inspect-uploaded-checklist'),agent:agent([uploaded]),signal:new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.content)).toContain(html)
  expect(savedDocumentReference(agent([]), file.attachmentId)).toBeUndefined()
  expect(savedDocumentReference(agent([uploaded]), '/tmp/checklist.md')).toBeUndefined()
  expect(savedDocumentReference(agent([{ ...uploaded,data:{ ...uploaded.data,source:{ kind:'plugin' } } }]), file.attachmentId)).toBeUndefined()
  expect(savedDocumentReference(agent([{ ...uploaded,data:{ ...uploaded.data,content:[{ type:'text',text:file.attachmentId }] } }]), file.attachmentId)).toBeUndefined()
  await native.fiber.dispose()
})
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

it('reads an exact native saved preview attachment ID without substituting it for document contents', async () => {
  const preview = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png' as const, bytes: png.byteLength, width: 4, height: 3 }
  const native = new Context(); await native.plugin(SystemPrompt); await native.plugin(ToolRuntime)
  native.provide('attachments', { ...ctx.attachments, readImage: async () => ({ ref: preview, data: png }) })
  registerArtifactInspection(native)
  for (const type of ['hivemind/generation-created', 'hivemind/artifact-created']) {
    const owner = agent([{ type, data: { artifactId: 'pdf-or-html', preview, file: documentFile, pdf: documentFile, mediaType: 'text/html' } }])
    const result = await native.tools.execute({ name: 'hivemind_artifact_inspect', arguments: { artifact_id: preview.attachmentId },
      callId: ToolCallId('inspect-native-preview-' + type), agent: owner, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(result.content).toContainEqual({ type: 'image', attachment: preview })
    expect(savedDocumentReference(owner, preview.attachmentId)).toBeUndefined()
  }
  await native.fiber.dispose()
})

it('distinguishes unsupported admitted documents, missing receipts and an actual image byte-budget overflow', async () => {
  const native = new Context(); await native.plugin(SystemPrompt); await native.plugin(ToolRuntime)
  native.provide('attachments', ctx.attachments)
  registerArtifactInspection(native)
  const run = (owner: Agent, id: string) => native.tools.execute({ name: 'hivemind_artifact_inspect', arguments: { artifact_id: id },
    callId: ToolCallId('inspect-reader-error'), agent: owner, signal: new AbortController().signal })
  const office = agent([{ type: 'hivemind/generation-created', data: { artifactId: 'office-file', file: documentFile, mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } }])
  const unsupported = await run(office, 'office-file')
  expect(unsupported.isError).toBe(true)
  expect(JSON.stringify(unsupported.content)).toContain('media type application/vnd.openxmlformats-officedocument.presentationml.presentation is not supported')
  expect(JSON.stringify(unsupported.content)).not.toContain('30 MiB')
  const unknownUpload = agent([{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'file', attachment: { ...documentFile, name: 'source.docx' } }] } }])
  expect(JSON.stringify((await run(unknownUpload, documentFile.attachmentId)).content)).toContain('application/octet-stream is not supported')
  const missing = await run(agent([]), 'not-admitted')
  expect(missing.isError).toBe(true)
  expect(JSON.stringify(missing.content)).toContain('Saved artifact receipt unavailable in this room')
  expect(JSON.stringify(missing.content)).not.toContain('30 MiB')
  const oversized = await run(agent([{ type: 'hivemind/generation-created', data: { artifactId: 'oversized-image', file: { ...file, bytes: 31 * 1024 * 1024 }, mediaType: 'image/png' } }]), 'oversized-image')
  expect(oversized.isError).toBe(true)
  expect(JSON.stringify(oversized.content)).toContain('Saved image exceeds 30 MiB inspection limit')
  await native.fiber.dispose()
})

it('keeps native preview IDs and owner-uploaded images bound to admitted receipts, denying prose, foreign receipts and host paths', async () => {
  const preview = { attachmentId: 'sha256:' + 'b'.repeat(64), mediaType: 'image/png' as const, bytes: png.byteLength, width: 4, height: 3 }
  const imageStore = { attachments: { ...ctx.attachments, readImage: async () => ({ ref: preview, data: png }) } } as unknown as Context
  const uploaded = { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: preview }] } }
  expect(await inspectSavedImage(imageStore, agent([uploaded]), preview.attachmentId, new AbortController().signal)).toEqual(preview)
  for (const events of [
    [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: preview.attachmentId }] } }],
    [{ type: 'hivemind/hq-task-artifacts', data: { artifactIds: [preview.attachmentId] } }],
    [{ type: 'hivemind/room-message-received', data: { targetId: 'foreign-room', senderId: 'producer', artifactIds: ['shared'], artifacts: [{ artifactId: 'shared', producerSessionId: 'producer', preview }] } }],
  ]) await expect(inspectSavedImage(imageStore, agent(events), preview.attachmentId, new AbortController().signal)).rejects.toThrow('receipt unavailable in this room')
  await expect(inspectSavedImage(imageStore, agent([uploaded]), '/tmp/preview.png', new AbortController().signal)).rejects.toThrow('receipt unavailable in this room')
  await expect(inspectSavedImage(imageStore, agent([uploaded]), preview.attachmentId.slice(0, 16), new AbortController().signal)).rejects.toThrow('receipt unavailable in this room')
})
