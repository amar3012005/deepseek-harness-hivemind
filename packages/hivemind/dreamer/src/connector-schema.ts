/** Preserve exact provider schemas in the existing durable Dreaming read capability. */
import type { DreamContract, DreamGrant } from '@deepseek-ai/dsh-hivemind-connected-apps'
export interface DreamBinding { grant: DreamGrant; contract: DreamContract }
/** Relocate local JSON references when nesting a provider's complete argument schema. */
function relocate(value: unknown, root: string): unknown {
  if (Array.isArray(value)) return value.map(item => relocate(item, root))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === '$ref' && typeof item === 'string' && item.startsWith('#/') ? `${root}${item.slice(1)}` : relocate(item, root)]))
}
export function dreamingReadSchema(bindings: readonly DreamBinding[]): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 100 },
      connector: { oneOf: bindings.map(({ grant, contract }, index) => ({
        type: 'object', additionalProperties: false, required: ['accountId', 'tool', 'arguments'],
        description: `${grant.label}: ${contract.description}`,
        properties: {
          accountId: { type: 'string', const: grant.id }, tool: { type: 'string', const: contract.slug },
          arguments: relocate(contract.schema, `#/properties/connector/oneOf/${index}/properties/arguments`),
        },
      })) },
    },
    oneOf: [{ required: ['ids'], not: { required: ['connector'] } }, { required: ['connector'], not: { required: ['ids'] } }],
  }
}
