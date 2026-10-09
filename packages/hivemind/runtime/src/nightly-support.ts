import { z } from 'zod'
/** Typed technical counts only: private reports and arbitrary message text cannot enter support email. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { requireAdministratorMessageOwner } from './administrator-messaging.ts'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Fresh Core canonical Runtime and organization timezone attestation. @mode serial */
    'hivemind/nightly-routine-context'(input:{ agent:Agent;signal:AbortSignal }):Promise<unknown>
  }
}
export const supportCapabilities = ['crm','employee_lifecycle','delegation','memory','voice','attention','artifacts','email','schedule','authorization','runtime'] as const
export const supportCodes = ['invalid_identifier','permission_denied','missing_configuration','tool_contract','delivery_failed','unavailable','unknown'] as const
const coverageSchema=z.object({
  expected:z.number().int().min(0).max(1000),
  inspected:z.number().int().min(0).max(1000),
  missing:z.number().int().min(0).max(1000),
}).strict().refine(c=>c.inspected+c.missing===c.expected)
const issueSchema=z.object({ capability:z.enum(supportCapabilities),code:z.enum(supportCodes),severity:z.enum(['critical','high','medium','low']),count:z.number().int().min(1).max(1000000),cause:z.enum(['confirmed','suspected','unknown']) }).strict()
const supportSchema=z.discriminatedUnion('operation',[z.object({ operation:z.literal('status'),occurrence:z.iso.datetime() }).strict(),z.object({ operation:z.literal('submit'),occurrence:z.iso.datetime(),coverage:coverageSchema,issues:z.array(issueSchema).max(20) }).strict()])
export function runtimeSupportReportTool(
  send: (agent: Agent, input: Record<string, JsonValue>, signal: AbortSignal) => Promise<Record<string, JsonValue>>,
) {
  return defineTool({
    name: 'runtime_support_report',
    description: 'Runtime only: send or inspect one sanitized technical Nightly routine check report to the server-configured SUPPORT inbox. Use the ORIGINAL saved scheduled occurrence as occurrence, including delayed work. Submit only evidence-backed coverage counts and the enumerated failure categories; no company documents, private memory, transcripts, raw logs, names, IDs, links, tokens, free text or repair instructions. Exact same occurrence and unchanged content reconcile retries without resending. Missing configuration is a visible blocker, never permission to choose a recipient or use another email tool. Status reads the actual provider delivery ledger. Accepted/queued is not delivered, delivered is not read, and this report grants no authority to repair or change access.',
    parameters: {
      operation: { type: 'string', enum: ['submit','status'], required: true },
      occurrence: { type: 'string', required: true, description: 'Original native scheduled occurrence as UTC RFC3339, not current time after a queue delay.' },
      coverage: { type: 'object', properties: {
        expected: { type: 'integer', required: true, description: '0 through 1000.' },
        inspected: { type: 'integer', required: true, description: '0 through 1000.' },
        missing: { type: 'integer', required: true, description: '0 through 1000; inspected + missing must equal expected.' },
      }, additionalProperties: false, description: 'Required for submit. Runtime plus active employees; unavailable evidence is missing coverage.' },
      issues: { type: 'array', description: 'Required for submit; empty only when inspected evidence supports no issue.', items: { type: 'object', additionalProperties: false, properties: {
        capability: { type: 'string', enum: [...supportCapabilities], required: true },
        code: { type: 'string', enum: [...supportCodes], required: true },
        severity: { type: 'string', enum: ['critical','high','medium','low'], required: true },
        count: { type: 'integer', required: true, description: 'Proven count from 1 through 1000000.' },
        cause: { type: 'string', enum: ['confirmed','suspected','unknown'], required: true },
      } } },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: args => args.operation === 'status',
    async execute(args, execution) {
      const agent=requireAdministratorMessageOwner(execution.agent)
      return send(agent, supportSchema.parse(args), execution.signal)
    },
  })
}
