import { describe, expect, it } from 'vitest'
import { artifactBlob, type ReadArtifactPage } from '../src/client/download.ts'

function reader(parts: string[], versions = parts.map(() => 'v1')): ReadArtifactPage {
  let index = 0
  return async (offset) => {
    const current = index++
    return { ok: true, value: {
      absolutePath: '/workspace/report.pdf', version: versions[current] ?? 'v1',
      offset, data: btoa(parts[current] ?? ''), eof: current === parts.length - 1,
      bytes: parts.join('').length,
    } }
  }
}

describe('authorized artifact downloads', () => {
  it('assembles binary pages without text decoding', async () => {
    const blob = await artifactBlob(reader(['%PDF\x00', '\xffend']), 'application/pdf')
    expect(blob.type).toBe('application/pdf')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([37, 80, 68, 70, 0, 255, 101, 110, 100])
  })
  it('rejects a file changed between pages', async () => {
    await expect(artifactBlob(reader(['a', 'b'], ['v1', 'v2']), 'application/pdf')).rejects.toThrow('changed')
  })
  it('rejects a stalled read', async () => {
    await expect(artifactBlob(reader(['', 'b']), 'application/pdf')).rejects.toThrow('progress')
  })
  it('rejects a partial EOF instead of downloading a corrupt file', async () => {
    await expect(artifactBlob(async () => ({ ok: true, value: {
      absolutePath: '/a', version: 'v1', bytes: 10, offset: 0, data: btoa('a'), eof: true,
    } }), 'application/pdf')).rejects.toThrow('Incomplete')
  })
  it('rejects oversized files before allocating their payload', async () => {
    await expect(artifactBlob(async () => ({ ok: true, value: {
      absolutePath: '/a', version: 'v1', bytes: 70 * 1024 * 1024, offset: 0, data: '', eof: true,
    } }), 'application/pdf')).rejects.toThrow('size limit')
  })
})
