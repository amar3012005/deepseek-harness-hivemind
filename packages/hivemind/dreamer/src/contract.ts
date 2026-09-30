/** Tenant-safe Dreamer contracts. Scheduling payloads never contain user-authored prompts. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
export const VERSION = 'dreamer-v1'
export const UUID = z.string().uuid()
export const triggerSchema = z.object({ workflow: z.literal(VERSION), revision: z.number().int().positive() }).strict()
export const checkpointSchema = z
  .object({ summary: z.string().trim().min(1).max(12000), next: z.string().max(6000), complete: z.boolean() })
  .strict()
export const candidateSchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    content: z.string().trim().min(1).max(12000),
    sourceIds: z.array(UUID).min(1).max(100),
    entities: z.array(z.string().trim().min(1).max(180)).max(100),
    reasoningType: z.enum(['temporal', 'cause_effect', 'contradiction', 'pattern', 'unresolved_thread', 'intersection', 'consequence']),
    confidence: z.number().min(0).max(1),
  })
  .strict()
export type Candidate = z.infer<typeof candidateSchema>
/** Stable across retries and later Dreamer runs; do not hash model-provided volatile keys. */
export function candidateKey(orgId: string, value: Candidate): string {
  return `dream:${createHash('sha256')
    .update(JSON.stringify([orgId, value.title.trim(), value.content.trim(), [...new Set(value.sourceIds)].sort(), value.reasoningType]))
    .digest('hex')}`
}
export function stableId(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
export function bearer(actual: string | undefined, expected: string | undefined): boolean {
  if (!expected || expected.length < 24 || !actual?.startsWith('Bearer ')) return false
  const a = Buffer.from(actual.slice(7)),
    b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
