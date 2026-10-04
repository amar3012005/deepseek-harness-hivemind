/** Private owner-scoped design exemplars, delivered through native logged tool results. */
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'

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
    && (['user', 'schedule', 'agent-message'].includes(item.data.source.kind)
      || (item.data.source.kind === 'plugin' && (!('form' in item.data.source) || item.data.source.form === undefined))))
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
  installNativeDesignSkillReference(ctx)
}

/** Enrich native skill results before they are logged and sent to the next model request. */
export function installNativeDesignSkillReference(ctx: Context): void {
  ctx.on('tools/post-execute', async (execution, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'accept' || 'value' in decision || result.isError || execution.name !== 'skill'
      || !execution.agent || typeof execution.arguments !== 'object' || execution.arguments === null
      || !('name' in execution.arguments) || execution.arguments.name !== 'design-artifact') return decision
    const agent = execution.agent
    const events = agent.session.snapshotEvents()
    const message = events.findLast(item => item.type === 'user/message'
      && ['user', 'schedule', 'agent-message'].includes(item.data.source.kind))
    if (message?.type === 'user/message' && message.data.source.kind === 'user' && message.data.content.some(block => block.type === 'image')) return decision
    execution.signal.throwIfAborted()
    const reference = currentDesignReference(events) ?? await ctx.serial('hivemind/design-reference', { agent, purpose: 'editorial' })
    execution.signal.throwIfAborted()
    if (!reference) return decision
    const content = decision.content ?? result.content
    if (content.some(block => block.type === 'image' && 'attachment' in block && block.attachment.attachmentId === reference.preview.attachmentId)) return decision
    return { ...decision, content: [...content,
      { type: 'text', text: 'Private visual design reference, supplied as actual pixels before authoring. Approved Brand DNA and explicit current user references take priority. When approved Brand DNA is absent, use this saved owner reference to shape composition, typography, spacing, color balance and illustration. A remembered homepage is factual context, not approved Brand DNA, and must not suppress this reference. For an Awakening Plan, put every real scheduled employee assignment first, then the strategy explaining it; distinguish confirmed schedules from proposals. Inspect these pixels now before writing HTML/CSS or the generation brief. Adapt the design to the company; never copy reference logos, words, claims or identity. Do not display or deliver this private reference itself.' },
      { type: 'image', attachment: reference.preview },
    ] }
  })
}
