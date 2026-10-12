import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { codexImageProvider, codexReferenceInputs } from '../src/codex-image-provider.ts'
const owner = { orgId: 'org-a', userId: 'user-a', sessionId: 'session-a' }
describe('Codex media recovery isolation', () => {
  it('refuses regeneration when a dispatched operation has no provider receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-reconcile-'))
    const auth = vi.fn(async () => undefined)
    try {
      const provider = codexImageProvider({ command: '/never-spawn', stateDirectory: root, model: 'test', timeoutMs: 1000, auth })
      await expect(provider.generate({ owner, operationId: 'missing', reconcileOnly: true, title: 'Test', content: 'Test', cwd: root, signal: new AbortController().signal })).rejects.toThrow('not regenerated')
      expect(auth).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('returns saved output only to the exact organization/user/session owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-owner-'))
    const operationId = 'owned'; const directory = join(root, createHash('sha256').update(operationId).digest('hex'))
    await mkdir(directory); const filename = join(directory, 'image.png')
    await writeFile(filename, Buffer.from('89504e470d0a1a0a', 'hex'))
    await writeFile(join(directory, 'operation.json'), JSON.stringify({ owner, status: 'completed', filename }))
    const auth = vi.fn(async () => undefined)
    const provider = codexImageProvider({ command: '/never-spawn', stateDirectory: root, model: 'test', timeoutMs: 1000, auth })
    const input = { operationId, title: 'Test', content: 'Test', cwd: root, signal: new AbortController().signal }
    try {
      for (const intruder of [{ ...owner, orgId: 'org-b' }, { ...owner, userId: 'user-b' }, { ...owner, sessionId: 'session-b' }]) {
        await expect(provider.generate({ ...input, owner: intruder })).rejects.toThrow('ownership mismatch')
      }
      await expect(provider.generate({ ...input, owner })).resolves.toMatchObject({ mediaType: 'image/png' })
      expect(auth).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

it('admits saved raster references as native conversation images without filesystem paths', async () => {
  const data = createCanvas(8, 8).toBuffer('image/png')
  const inputs = await codexReferenceInputs([{ data }])
  expect(inputs).toEqual([{ type: 'image', url: `data:image/png;base64,${data.toString('base64')}` }])
  await expect(codexReferenceInputs([{ data: new Uint8Array([1,2,3]) }])).rejects.toThrow('PNG, JPEG or WebP')
  await expect(codexReferenceInputs(Array.from({ length: 6 }, () => ({ data })))).rejects.toThrow('five')
  await expect(codexReferenceInputs([{ data: new Uint8Array(31 * 1024 * 1024) }])).rejects.toThrow('byte budget')
})

it('preserves confirmed terminal failures without starting another worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-failed-'))
  const operationId = 'failed'; const directory = join(root, createHash('sha256').update(operationId).digest('hex'))
  await mkdir(directory)
  await writeFile(join(directory, 'operation.json'), JSON.stringify({ owner, status: 'failed' }))
  const auth = vi.fn(async () => undefined)
  try {
    const provider = codexImageProvider({ command: '/never-spawn', stateDirectory: root, model: 'test', timeoutMs: 1000, auth })
    await expect(provider.generate({ owner, operationId, title: 'Test', content: 'Test', cwd: root, signal: new AbortController().signal })).rejects.toThrow('ended without output')
    expect(auth).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})
