/** Optional Cordis tools for versioned HIVEMIND application specifications. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertSupportedJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { appSpecSchema } from './appspec-schema.ts'
import { request, trustedOrigin, type TransportConfig } from './transport.ts'
import type {} from '@deepseek-ai/dsh-skill'
import { crmBuilderSkill } from './skill.ts'

export const name = 'hivemind-app-builder'
export const inject = ['tools', 'skills', 'hivemindExecutionScope']

/** Configuration is supplied only by the future deployment composition. */
export interface Config extends TransportConfig { maxRequestBytes: number }
export const Config: z<Config> = z.object({
  serviceApiBase: z.string().required(),
  serviceSecretEnv: z.string().default('HIVE_HARNESS_RUNNER_SERVICE_SECRET'),
  requestTimeoutMs: z.natural().min(1).max(120_000).default(30_000),
  maxResponseBytes: z.natural().min(1024).max(8_388_608).default(1_048_576),
  maxRequestBytes: z.natural().min(1024).max(524_288).default(262_144),
})

const str: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer' }
const nullableInteger: JsonSchemaNode = { oneOf: [integer, { type: 'null' }] }
const data: JsonSchemaNode = { type: 'object', additionalProperties: true }
function object(properties: Record<string, JsonSchemaNode>, required = Object.keys(properties)): JsonSchemaNode {
  return { type: 'object', additionalProperties: false, properties, required }
}
const app = object({ id: str, version: integer, publishedVersion: nullableInteger, spec: appSpecSchema, createdAt: str, updatedAt: str })
const record = object({ id: str, appId: str, entityId: str, version: integer, data, createdAt: str, updatedAt: str })
const appResult = object({ app })
const recordResult = object({ record })
const operation = { type: 'string', description: 'Stable operation ID (1–180 ASCII letters, numbers, dots, underscores, colons or hyphens). Reuse it with an identical request when reconciling an interrupted write; never mint another ID for that retry.' } satisfies JsonSchemaNode
const appId = { type: 'string', description: 'Application UUID returned by a previous tool.' } satisfies JsonSchemaNode
const version = { type: 'integer', description: 'Positive current version returned by get. A conflict requires inspecting current state before preparing another edit.' } satisfies JsonSchemaNode

interface Operation {
  name: string
  description: string
  properties: Record<string, JsonSchemaNode>
  required?: string[]
  output: JsonSchemaNode
  method: 'GET' | 'POST' | 'PATCH'
  route(input: Record<string, JsonValue>): string
  body?(input: Record<string, JsonValue>): unknown
}
const encodedApp = (input: Record<string, JsonValue>) => `/${encodeURIComponent(input.app_id as string)}`
const operations: Operation[] = [
  { name: 'hivemind_app_create_draft', description: 'Create a data-only application draft. Use stable lowercase entity/field/view identifiers. Nothing is published. SQL, scripts, workflow definitions and executable UI are unsupported.',
    properties: { spec: appSpecSchema, operation_id: operation }, output: appResult, method: 'POST', route: () => '',
    body: i => ({ spec: i.spec, operationId: i.operation_id }) },
  { name: 'hivemind_app_get', description: 'Read the current application definition and version before editing. Tenant access is checked by the server.',
    properties: { app_id: appId }, output: appResult, method: 'GET', route: encodedApp },
  { name: 'hivemind_app_patch', description: 'Replace a draft specification using the current expected version. Include every retained entity, field and view. Existing records are preserved; incompatible changes require a data migration and may be rejected.',
    properties: { app_id: appId, expected_version: version, spec: appSpecSchema, operation_id: operation }, output: appResult, method: 'PATCH', route: encodedApp,
    body: i => ({ expectedVersion: i.expected_version, spec: i.spec, operationId: i.operation_id }) },
  { name: 'hivemind_app_validate', description: 'Validate a persisted draft using authoritative server business rules before preview or publication.',
    properties: { app_id: appId }, output: object({ valid: { type: 'boolean', const: true }, spec: appSpecSchema }), method: 'POST', route: i => `${encodedApp(i)}/validate`, body: () => ({}) },
  { name: 'hivemind_app_preview', description: 'Read the current draft for preview. This returns declarative view definitions; it does not publish, execute generated code or imply that a frontend renderer is installed.',
    properties: { app_id: appId }, output: appResult, method: 'GET', route: encodedApp },
  { name: 'hivemind_app_publish', description: 'Publish a validated application version. Server membership and publication permission are mandatory. Return confirms publication, not deployment of executable code.',
    properties: { app_id: appId, expected_version: version, operation_id: operation }, output: appResult, method: 'POST', route: i => `${encodedApp(i)}/publish`,
    body: i => ({ expectedVersion: i.expected_version, operationId: i.operation_id }) },
  { name: 'hivemind_app_query_records', description: 'Read a bounded page of records from one known entity. Use field definitions from app_get to interpret data. Omit after for the first page.',
    properties: { app_id: appId, entity_id: str, limit: { type: 'integer', description: 'Page size from 1 to 25. Omit for 25.' }, after: str }, required: ['app_id', 'entity_id'],
    output: object({ records: { type: 'array', items: record }, nextCursor: { oneOf: [str, { type: 'null' }] } }), method: 'GET',
    route: i => `${encodedApp(i)}/records?${new URLSearchParams({ entityId: i.entity_id as string, limit: String(i.limit ?? 25), ...(i.after === undefined ? {} : { after: i.after as string }) })}` },
  { name: 'hivemind_app_create_record', description: 'Create one application record. Data keys are field IDs from app_get; dates use YYYY-MM-DD. Core validates types, required fields, references and source ownership.',
    properties: { app_id: appId, entity_id: str, data, operation_id: operation }, output: recordResult, method: 'POST', route: i => `${encodedApp(i)}/records`,
    body: i => ({ entityId: i.entity_id, data: i.data, operationId: i.operation_id }) },
  { name: 'hivemind_app_update_record', description: 'Update record fields with an expected current record version. Omitted fields stay unchanged. Server validates permissions and values. Reuse the operation ID only with the identical payload.',
    properties: { app_id: appId, record_id: str, expected_version: version, data, operation_id: operation }, output: recordResult, method: 'PATCH',
    route: i => `${encodedApp(i)}/records/${encodeURIComponent(i.record_id as string)}`,
    body: i => ({ expectedVersion: i.expected_version, data: i.data, operationId: i.operation_id }) },
]

/** Install optional tools without changing agent behavior, skills, presets or prompts.
 * @param ctx - Native Cordis context with tools and scoped identity services.
 * @param config - Explicit deployment transport configuration.
 */
export function apply(ctx: Context, config: Config): void {
  trustedOrigin(config.serviceApiBase)
  ctx.effect(() => ctx.skills.register(crmBuilderSkill))
  for (const operation of operations) {
    const parameters = object(operation.properties, operation.required ?? Object.keys(operation.properties))
    assertSupportedJsonSchema(parameters)
    ctx.effect(() => ctx.tools.register({
      name: operation.name, description: operation.description, parameters: { ...parameters },
      output: { schema: operation.output, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => operation.method === 'GET',
      async execute(args, exec) {
        const violations = validateJsonSchemaValue(parameters, args, 'arguments')
        if (violations.length) throw new TypeError(`app-builder: ${violations.join('; ')}`)
        const input = args as Record<string, JsonValue>
        for (const key of ['app_id', 'record_id', 'after']) if (input[key] !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input[key] as string)) throw new TypeError(`app-builder: ${key} must be a UUID`)
        if (input.entity_id !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/.test(input.entity_id as string)) throw new TypeError('app-builder: entity_id must be a stable lowercase identifier')
        if (input.operation_id !== undefined && !/^[A-Za-z0-9._:-]{1,180}$/.test(input.operation_id as string)) throw new TypeError('app-builder: operation_id must contain 1–180 ASCII letters, numbers, dots, underscores, colons or hyphens')
        if (input.expected_version !== undefined && (!Number.isSafeInteger(input.expected_version) || (input.expected_version as number) < 1)) throw new TypeError('app-builder: expected_version must be a positive safe integer')
        if (input.limit !== undefined && ((input.limit as number) < 1 || (input.limit as number) > 25)) throw new TypeError('app-builder: limit must be 1–25')
        const body = operation.body?.(input)
        if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > config.maxRequestBytes) throw new TypeError('app-builder: request exceeds configured byte limit')
        const result = await request(ctx, config, operation.route(input), operation.method, body, exec.signal)
        const outputViolations = validateJsonSchemaValue(operation.output, result, 'result')
        if (outputViolations.length) throw new Error(operation.method === 'GET'
          ? 'app-builder: server result does not match App Runtime v1'
          : 'app-builder: write outcome is unknown because the receipt does not match App Runtime v1; reconcile using the same operation_id')
        return result
      },
      presentCall: () => ({ card: 'generic', title: operation.name.replace(/^hivemind_app_/, '').replaceAll('_', ' '), kind: operation.method === 'GET' ? 'read' : 'edit' }),
    }))
  }
}
