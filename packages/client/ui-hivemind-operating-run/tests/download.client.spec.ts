import { describe, expect, it } from 'vitest'
import { fileArtifactBlob } from '../src/client/download.ts'

describe('authorized artifact downloads', () => {
  it('preserves binary PDF bytes', async () => {
    const blob = fileArtifactBlob(btoa('%PDF\x00\xffend'), 'application/pdf', 9)
    expect(blob.type).toBe('application/pdf')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([37, 80, 68, 70, 0, 255, 101, 110, 100])
  })
  it('rejects incomplete and oversized files', () => {
    expect(() => fileArtifactBlob(btoa('a'), 'application/pdf', 10)).toThrow('Incomplete')
    expect(() => fileArtifactBlob('', 'application/pdf', 70 * 1024 * 1024)).toThrow('size limit')
  })
})
