/** Private owner-scoped design exemplars, delivered through native logged tool results. */
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface DesignReference { id: string; preview: ImageAttachmentRef; sha256: string }
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Load one authorized private visual exemplar before authoring.
     * @param input - Active agent and declared design purpose.
     * @mode serial
     */
    'hivemind/design-reference'(input: { agent: Agent; purpose: string }): Promise<DesignReference | undefined>
  }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Owner-authorized reference selection, not a generated or chat-uploaded artifact. */
    'hivemind/design-reference-selected': DesignReference
  }
}
export function referenceOwnerKey(orgId: string, userId: string): string {
  return createHash('sha256').update(JSON.stringify([orgId, userId])).digest('hex')
}
export function currentDesignReference(events: readonly SessionEvent[]): DesignReference | undefined {
  const latestMessage = events.findLastIndex(item => item.type === 'user/message'
    && (item.data.source.kind !== 'plugin' || !('form' in item.data.source) || item.data.source.form === undefined))
  const boundary = Math.max(latestMessage, events.findLastIndex(item => item.type === 'turn/start'))
  const selected = events.slice(boundary + 1).findLast(item => item.type === 'hivemind/design-reference-selected')
  return selected?.type === 'hivemind/design-reference-selected' ? selected.data : undefined
}
export async function readPrivateReference(
  directory: string, orgId: string, userId: string, purpose: string,
): Promise<{ id: string; data: Uint8Array; sha256: string } | undefined> {
  const root = join(directory, referenceOwnerKey(orgId, userId))
  let manifestText: string
  try {
    const base = await realpath(directory); const actualRoot = await realpath(root)
    if (actualRoot !== join(base, referenceOwnerKey(orgId, userId))) throw new Error('Private reference owner directory is redirected')
    const manifestPath = await realpath(join(root, 'manifest.json'))
    if (manifestPath !== join(actualRoot, 'manifest.json') || (await stat(manifestPath)).size > 64_000) throw new Error('Private reference manifest is redirected or exceeds limit')
    manifestText = await readFile(manifestPath, 'utf8')
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const manifest = JSON.parse(manifestText) as {
    version: number
    orgId: string
    userId: string
    references: { id: string; file: string; sha256: string; purposes: string[] }[]
  }
  if (manifest.version !== 1 || manifest.orgId !== orgId || manifest.userId !== userId || !Array.isArray(manifest.references) || manifest.references.length > 20) throw new Error('Private design reference ownership or manifest invalid')
  const candidates = manifest.references.filter(item => typeof item.id === 'string' && typeof item.file === 'string' && /^[a-f0-9]{64}$/.test(item.sha256) && Array.isArray(item.purposes))
  const selected = candidates.find(item => item.purposes.includes(purpose)) ?? candidates.find(item => item.purposes.includes('editorial'))
  if (!selected) return undefined
  if (!/^[a-z0-9-]+\.png$/.test(selected.file)) throw new Error('Invalid private reference filename')
  const actualRoot = await realpath(root); const path = await realpath(join(root, selected.file))
  const rel = relative(actualRoot, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Private reference escapes owner directory')
  if ((await stat(path)).size > 5_000_000) throw new Error('Private design reference exceeds 5 MB')
  const data = await readFile(path)
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || createHash('sha256').update(data).digest('hex') !== selected.sha256) throw new Error('Private design reference integrity mismatch')
  return { id: selected.id, data, sha256: selected.sha256 }
}
export function registerPrivateDesignReferences(ctx: Context, directory: string): void {
  if (!directory) return
  ctx.on('hivemind/design-reference', async ({ agent, purpose }) => {
    const sessionId = String(agent.session.header.id)
    const owner = await ctx.serial('hivemind/media-owner', { sessionId })
    if (!owner?.orgId || !owner.userId || owner.sessionId !== sessionId) throw new Error('Private reference authenticated owner unavailable')
    const reference = await readPrivateReference(directory, owner.orgId, owner.userId, purpose)
    if (!reference) return undefined
    const preview = await ctx.attachments.saveImage({ data: reference.data, mediaType: 'image/png', name: 'private-design-reference.png' })
    const result = { id: reference.id, sha256: reference.sha256, preview }
    agent.session.append('hivemind/design-reference-selected', result)
    if (!(await ctx.sessions.flush(agent.session))) throw new Error('Private reference receipt could not be saved')
    return result
  })
}
