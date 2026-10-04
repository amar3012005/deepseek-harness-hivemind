import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { currentDesignReference, readPrivateReference, referenceOwnerKey } from '../src/design-reference.ts'

describe('private owner-scoped visual reference', () => {
  it('retains pixels across context snapshots but clears them for new initiating work', () => {
    const selected = { id: 'editorial', sha256: 'hash', preview: { attachmentId: 'pixels' } }
    const events = [{ type: 'user/message', data: { source: { kind: 'user' } } }, { type: 'hivemind/design-reference-selected', data: selected }, { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'time-context', form: 'snapshot' } } }]
    expect(currentDesignReference(events as never)).toEqual(selected)
    expect(currentDesignReference([...events, { type: 'user/message', data: { source: { kind: 'user' } } }] as never)).toBeUndefined()
    expect(currentDesignReference([...events, { type: 'user/message', data: { source: { kind: 'schedule' } } }] as never)).toBeUndefined()
    expect(currentDesignReference([...events, { type: 'turn/start', data: { turn: 2 } }] as never)).toBeUndefined()
  })
  it('selects one relevant image and keeps different users isolated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'design-reference-'))
    try {
      const root = join(directory, referenceOwnerKey('org', 'user')); await mkdir(root)
      const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      const sha256 = createHash('sha256').update(data).digest('hex')
      await writeFile(join(root, 'editorial.png'), data)
      await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, orgId: 'org', userId: 'user', references: [{ id: 'editorial', file: 'editorial.png', sha256, purposes: ['editorial', 'presentation'] }] }))
      expect((await readPrivateReference(directory, 'org', 'user', 'presentation'))?.id).toBe('editorial')
      expect(await readPrivateReference(directory, 'org', 'other', 'presentation')).toBeUndefined()
      await writeFile(join(root, 'editorial.png'), Buffer.from('corrupt'))
      await expect(readPrivateReference(directory, 'org', 'user', 'editorial')).rejects.toThrow('integrity')
      await rm(join(root, 'editorial.png'))
      await writeFile(join(directory, 'outside.png'), data); await symlink(join(directory, 'outside.png'), join(root, 'editorial.png'))
      await expect(readPrivateReference(directory, 'org', 'user', 'editorial')).rejects.toThrow('escapes')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
