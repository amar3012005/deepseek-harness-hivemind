// @vitest-environment jsdom
import { expect, it } from 'vitest'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { decodeArtifactText } from '../src/client/artifact-text.ts'
// Captured transferred receipt identity and byte count; body is a synthetic test fixture.
const file = {
  attachmentId: 'sha256:754e9b36f64d2bfaa9187dc645cd32cc0be7736454e9eb0497322dc47e236c3c',
  name: 'brief.md', bytes: 705,
} as FileAttachmentRef
it('decodes native transferred bytes for the 705-byte receipt', () => {
  const text = '# Café brief\n' + 'x'.repeat(691)
  const bytes = new TextEncoder().encode(text)
  expect(bytes.length).toBe(705)
  expect(decodeArtifactText(file, { ok: true, value: { attachment: file, data: bytes } })).toBe(text)
})
it('keeps a rejected recipient authorization blocked, without using the producer session', () => {
  expect(() => decodeArtifactText(file, { ok: false })).toThrow('Artifact preview unavailable')
})
it('rejects mismatched decoded bytes', () => {
  expect(() => decodeArtifactText(file, { ok: true, value: { attachment: file, data: new TextEncoder().encode('short') } })).toThrow('Artifact size mismatch')
})

it('rejects a receipt reference from another artifact even when byte counts match', () => {
  const other = { ...file, attachmentId: 'sha256:other' as FileAttachmentRef['attachmentId'] }
  expect(() => decodeArtifactText(file, { ok: true, value: { attachment: other, data: new TextEncoder().encode('x'.repeat(file.bytes)) } }))
    .toThrow('Artifact preview unavailable')
})
