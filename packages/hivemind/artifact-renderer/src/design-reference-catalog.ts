/** Server-owned inspiration catalog; image bytes are never fetched from model-supplied URLs. */
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const defaultDesignCatalogDirectory = '/opt/deepseek-harness/design-reference-catalog'
export type DesignReferenceSummary = { id: string; title: string; description: string; purposes: string[]; source: string }
interface Entry extends DesignReferenceSummary { file: string; sha256: string }
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode serial */
    'hivemind/design-reference-list'(input: { agent: Agent }): Promise<DesignReferenceSummary[]>
  }
}

async function entries(directory: string): Promise<Entry[]> {
  let root: string
  try { root = await realpath(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const manifest = await realpath(join(root, 'manifest.json'))
  if (manifest !== join(root, 'manifest.json') || (await stat(manifest)).size > 128_000) throw new Error('Design catalog manifest exceeds its trusted boundary')
  const value = JSON.parse(await readFile(manifest, 'utf8')) as { version: number; references: Entry[] }
  if (value.version !== 1 || !Array.isArray(value.references) || value.references.length > 64) throw new Error('Invalid design catalog')
  const ids = new Set<string>()
  for (const item of value.references) {
    if (!/^[a-z0-9-]+$/.test(item.id) || ids.has(item.id) || !/^[a-z0-9-]+\.png$/.test(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256)
      || typeof item.title !== 'string' || item.title.length > 160 || typeof item.description !== 'string' || item.description.length > 1000
      || !Array.isArray(item.purposes) || item.purposes.some(p => typeof p !== 'string' || p.length > 60)
      || typeof item.source !== 'string' || !/^https:\/\/(?:in\.)?pinterest\.com\/pin\/\d+\/$/.test(item.source)) throw new Error('Invalid design reference metadata')
    ids.add(item.id)
  }
  return value.references
}
export async function listDesignReferences(directory: string): Promise<DesignReferenceSummary[]> {
  return (await entries(directory)).map(({ id, title, description, purposes, source }) => ({ id, title, description, purposes, source }))
}
export async function readCatalogReference(directory: string, id: string): Promise<{ id: string; data: Uint8Array; sha256: string }> {
  const item = (await entries(directory)).find(item => item.id === id)
  if (!item) throw new Error('Choose an exact reference ID from the design catalog')
  const root = await realpath(directory); const path = await realpath(join(root, item.file)); const rel = relative(root, path)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || (await stat(path)).size > 5_000_000) throw new Error('Design reference escapes catalog or exceeds image limit')
  const data = await readFile(path)
  if (!data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || createHash('sha256').update(data).digest('hex') !== item.sha256) throw new Error('Design reference integrity mismatch')
  return { id: item.id, data, sha256: item.sha256 }
}
export function registerDesignReferenceCatalog(ctx: Context, directory: string): void {
  ctx.on('hivemind/design-reference-list', () => listDesignReferences(directory))
  ctx.tools.register(defineTool({
    name: 'hivemind_design_reference',
    description: 'Before visual HTML or image authoring, read the reference catalog descriptions (omit reference_id), choose the best composition for the brief, then call again with that exact reference_id to receive actual image pixels. Inspect the image before authoring. Sources are inspiration only: do not copy their branding, words or factual claims. Current user references take priority.',
    parameters: { reference_id: { type: 'string', description: 'Exact reference ID chosen after reading the catalog descriptions.' } },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => {
      const preview = (value as { preview?: ImageAttachmentRef }).preview
      return [{ type: 'text' as const, text: JSON.stringify(value) }, ...(preview ? [{ type: 'image' as const, attachment: preview }] : [])]
    } },
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      if (!execution.agent) throw new Error('Design reference requires an active owned session')
      if (!args.reference_id) return { status: 'choose_reference', references: await listDesignReferences(directory) }
      const reference = await ctx.serial('hivemind/design-reference', { agent: execution.agent, purpose: 'editorial', referenceId: args.reference_id })
      if (!reference) throw new Error('Selected design reference unavailable')
      return { status: 'ready', reference_id: reference.id, sha256: reference.sha256, preview: { ...reference.preview },
        instruction: 'Inspect these actual pixels, then author the requested artifact using this visual direction. Never embed this inspiration image itself as the deliverable.' }
    },
    presentCall(args) { return { card: 'generic', title: args.reference_id ? 'Inspect a design reference' : 'Choose a design reference', kind: 'read', rawInput: args.reference_id ?? '' } },
  }))
}
