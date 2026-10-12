import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const profileDirectories: string[] = []

afterEach(async () => {
  await Promise.all(profileDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('HIVE agent preset file includes', () => {
  it.each(['hivemind-hq', 'hivemind-hyperagents'])('%s resolves its shared composition from the installed bundle', async (preset) => {
    const profileDir = await mkdtemp(join(tmpdir(), 'hive-preset-include-'))
    profileDirectories.push(profileDir)
    const packageLink = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-hivemind-web-app')
    await mkdir(join(profileDir, 'node_modules', '@deepseek-ai'), { recursive: true })
    await symlink(packageDir, packageLink, 'dir')

    const patch = load(await readFile(join(packageDir, 'presets', `${preset}.patch.yml`), 'utf8'), { schema: entryListSchema }) as Array<{
      insert?: Array<{ id?: string; config?: { plugins?: Array<{ id?: string; name?: string; config?: { path?: string } }> } }>
    }>
    const presetRow = patch.flatMap(layer => layer.insert ?? []).find(row => row.id === `preset-${preset}`)
    const includePath = presetRow?.config?.plugins?.find(row => row.id === 'hivemind-chat-base')?.config?.path
    expect(includePath).toBe('./node_modules/@deepseek-ai/dsh-hivemind-web-app/presets/hivemind-chat.agent.yml')

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(profileDir).href + '/'
    const include = new Include(ctx, { path: includePath! }) as unknown as {
      filename: string
      data?: unknown[]
      read(): Promise<boolean>
    }
    try {
      await include.read()
      expect(include.filename).toBe(join(packageLink, 'presets', 'hivemind-chat.agent.yml'))
      expect(include.data?.length).toBeGreaterThan(0)
      const sourceAsset = join(packageDir, 'presets', 'hivemind-chat.agent.yml')
      expect(await realpath(include.filename)).toBe(await realpath(sourceAsset))
      const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
      expect(digest(await readFile(include.filename))).toBe(digest(await readFile(sourceAsset)))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
