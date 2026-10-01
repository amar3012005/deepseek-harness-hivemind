/** Direct, version-pinned read tools for Dreaming. No model-side discovery or OAuth. */
import type { Composio } from '@composio/core'
import Ajv from 'ajv'
import { createHash } from 'node:crypto'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export interface DreamAccount { id: string; toolkit: string; label: string; subject: string }
export interface DreamContract {
  slug: string
  toolkit: string
  version: string
  description: string
  schema: Record<string, unknown>
  hash: string
}
export interface DreamGrant extends DreamAccount { userId: string }
export interface DreamContractCache {
  read(toolkit: string): Promise<DreamContract[] | undefined>
  write(toolkit: string, contracts: DreamContract[]): Promise<void>
}
const mutation = new RegExp([
  'SEND|CREATE|POST|PUBLISH|UPDATE|EDIT|DELETE|REMOVE|INVITE|PAY|TRANSFER|UPLOAD|WRITE|ADD|CANCEL|SCHEDULE|MARK_',
  'ARCHIVE|MOVE|MODIFY|PATCH|SUBMIT|APPEND|RESTORE|ASSIGN|RENAME|ENABLE|DISABLE|EXECUTE|RUN_',
].join('|'), 'i')
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false })

/** Provider tags alone are not authorization: use a positive read vocabulary as well. */
export function isDreamReadTool(slug: string, tags: readonly string[]): boolean {
  return tags.includes('readOnlyHint') && !tags.some(tag => ['createHint', 'updateHint', 'destructiveHint'].includes(tag))
    && !mutation.test(slug)
    && /(?:_GET_|_FETCH_|_LIST_|_SEARCH_|_FIND_|_READ_|_RETRIEVE_|_QUERY_)/.test(slug)
}
export function validateDreamArguments(schema: Record<string, unknown>, args: unknown): string[] {
  const validate = ajv.compile(schema)
  return validate(args) ? [] : (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
}

export class DreamConnectorService {
  private readonly pending = new Map<string, Promise<DreamContract[]>>()
  constructor(private readonly client: Promise<Composio> | undefined,
    private readonly receipt: (e: ToolRunContext, value: unknown, tool: string) => Promise<JsonValue>,
    private readonly project: (value: unknown, receipt: JsonValue) => JsonValue,
    private readonly maxTools: number, private readonly maxSchemaChars: number,
    private readonly admit: (e: ToolRunContext, slug: string) => Promise<void>) {
  }
  get available(): boolean { return this.client !== undefined }
  /** Listing credentials never becomes model context. Existing company connections are explicitly labelled. */
  async accounts(identity: { userId: string; orgId: string }, signal?: AbortSignal): Promise<DreamAccount[]> {
    if (!this.client) return []
    const client = await this.client
    const canonical = `hivemind:${identity.userId}`
    const collect = async (subject: string, company: boolean) => {
      const found: DreamAccount[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const result = await client.connectedAccounts.list({ userIds: [subject], statuses: ['ACTIVE'], limit: 100,
          ...(cursor === undefined ? {} : { cursor }) }, signal === undefined ? undefined : { signal })
        for (const item of result.items) {
          const value = item as unknown as Record<string, unknown>
          const toolkit = record(value.toolkit) ? String(value.toolkit.slug ?? '') : String(value.toolkit ?? value.toolkit_slug ?? '')
          const id = typeof value.id === 'string' ? value.id : ''
          if (!id || !/^[a-z0-9_]+$/i.test(toolkit) || !/^(ACTIVE|CONNECTED)$/i.test(String(value.status))) continue
          const label = toolkit.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
          found.push({ id, toolkit, subject, label: `${label}${company ? ' · company connection' : ''} · ${id.slice(-6)}` })
        }
        const next = (result as unknown as { nextCursor?: string | null }).nextCursor
        if (!next) return found
        cursor = next
      }
      throw new Error('Connected account list is too large to verify completely.')
    }
    const personal = await collect(canonical, false)
    // Match the existing chat adapter's historical account ownership, without mixing subjects.
    return personal.length ? personal : collect(identity.orgId, true)
  }
  async contracts(toolkit: string, cache: DreamContractCache, signal?: AbortSignal): Promise<DreamContract[]> {
    const cached = await cache.read(toolkit)
    if (cached) return cached
    if (!this.client) return []
    const key = toolkit
    let pending = this.pending.get(key)
    if (!pending) {
      pending = (async () => {
        const client = await this.client as Composio
        const listed = await client.tools.getRawComposioTools({ toolkits: [toolkit], tags: ['readOnlyHint'], limit: 100 },
          undefined, signal === undefined ? undefined : { signal })
        const rank = (slug: string): number => /SEARCH|FETCH_EMAILS|LIST_FILES|FETCH_MESSAGE_BY_ID/.test(slug)
          ? 0 : /LIST|FETCH|GET/.test(slug) ? 1 : 2
        const candidates = listed.filter(item => !item.isDeprecated && isDreamReadTool(item.slug, item.tags ?? []))
          .sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug))
        const selected: DreamContract[] = []
        for (const candidate of candidates) {
          if (selected.length >= this.maxTools) break
          const current = await client.tools.getRawComposioToolBySlug(candidate.slug, { version: 'latest' },
            signal === undefined ? undefined : { signal })
          if (current.isDeprecated || !isDreamReadTool(current.slug, current.tags ?? []) || !current.version
            || current.version === 'latest' || current.toolkit?.slug !== toolkit || !current.inputParameters) continue
          const schema = JSON.parse(JSON.stringify(current.inputParameters)) as Record<string, unknown>
          // Reject oversized contracts rather than silently deleting constraints.
          if (JSON.stringify(schema).length > this.maxSchemaChars || schema.type !== 'object') continue
          ajv.compile(schema)
          selected.push({ slug: current.slug, toolkit, version: current.version,
            description: (current.description ?? current.name).slice(0, 700), schema,
            hash: digest({ version: current.version, schema }) })
        }
        return selected
      })()
      this.pending.set(key, pending)
      void pending.finally(() => this.pending.delete(key)).catch(() => {})
    }
    const result = await pending
    await cache.write(toolkit, result)
    return result
  }
  /** The caller must recheck durable grants immediately before this method. */
  async execute(grant: DreamGrant, contract: DreamContract, args: unknown, e: ToolRunContext): Promise<JsonValue> {
    if (!this.client || contract.toolkit !== grant.toolkit || !isDreamReadTool(contract.slug, ['readOnlyHint']))
      throw new Error('Dreaming connector access unavailable.')
    const errors = validateDreamArguments(contract.schema, args)
    if (errors.length) return { status: 'invalid_arguments', issues: errors, executed: false }
    e.signal.throwIfAborted()
    const client = await this.client
    // An exact account pin and concrete version prevent account fallback and schema drift.
    await this.admit(e, contract.slug)
    const result = await client.tools.execute(contract.slug, { connectedAccountId: grant.id,
      userId: grant.subject, version: contract.version, arguments: args as Record<string, unknown> }, { signal: e.signal })
    const receipt = await this.receipt(e, result, contract.slug)
    if (!result.successful || result.error) return { status: 'read_unavailable', connectorExecuted: true,
      source_receipt: receipt, message: 'The app could not complete this read. Continue with other evidence; do not treat this as a source.' }
    return this.project(result, receipt)
  }
}
