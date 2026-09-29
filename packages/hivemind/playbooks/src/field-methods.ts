/** Optional field recipes; the parent chooses stages and native execution tools. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** A field's recommended stages, without an enforced execution graph. */
export interface FieldMethod {
  readonly id: string
  readonly capabilities: readonly string[]
  readonly workflowRef: 'native:workflow'
  readonly stages: Readonly<Record<string, string>>
}

/** Recipes carry only task-specific guidance and accurate completion conditions. */
export const FIELD_METHODS: readonly FieldMethod[] = [
  { id: 'campaign-launch', capabilities: ['research', 'artifact', 'visual', 'connected'], workflowRef: 'native:workflow', stages: {
    evidence: 'Read company claims, audience and channel evidence. Keep company assertions distinct from independently verified facts. Gather independent missing facts concurrently when useful. Produce a short claim/source ledger.',
    brand: 'Load stored Brand DNA. If missing, capture the official site and inspect its visual identity. Use observed colours, typography and imagery; label inferred guidance. Keep brand references available for asset generation.',
    assets: 'Choose channel-appropriate copy and artifacts. Discover configured generators, load only the necessary skill, and create editable assets. Preserve exact claims and citations. Inspect visual output before presenting it as publication-ready.',
    review: 'Review the exact assets for factual support, legibility, brand consistency and regulatory overclaims. Use an inline employee when helpful. Return concrete revisions or a ready-for-approval draft; internal review is not legal certification.',
    approval: 'Present the exact publication payload, channels and intended account. Request native approval for the external action. A rejected or pending decision leaves publishing pending; do not mark the campaign launched.',
    publish: 'Execute the approved publication through authenticated connected tools. Reuse its connection continuation. Report delivery only from the provider receipt, retaining post IDs and URLs. Never substitute an internal file for publication.',
    measure: 'Read available platform analytics for the published IDs and stated measurement window. Distinguish actual metrics from targets. If the measurement date is future, schedule a native workflow/job and report it as pending, not measured.',
  } },
  { id: 'sales-outreach', capabilities: ['research', 'artifact', 'connected'], workflowRef: 'native:workflow', stages: {
    qualify: 'Use the company ICP and current recipient/account evidence. Deduplicate and explain fit. Inferred email formats are not verified addresses. Produce a prospect sheet with sources and uncertainty.',
    draft: 'Use the actual relationship, evidence-backed offer, sender and recipient. Produce concise personalized drafts and a concrete next step. Do not invent familiarity or customer proof.',
    approve: 'Resolve the authenticated sending account and exact recipients. Present the messages for the applicable native approval. Keep drafts editable until approved.',
    deliver: 'Continue the same Composio operation after connection or approval. Preserve the provider message ID. If a send times out ambiguously, check delivery before retrying; never send a duplicate merely because the response was lost.',
    followup: 'Log verified delivery into the selected CRM only when requested. Schedule selected follow-ups with native durable tools. Report planned follow-ups separately from sent messages.',
  } },
  { id: 'finance-legal-review', capabilities: ['research', 'artifact', 'connected'], workflowRef: 'native:workflow', stages: {
    scope: 'Establish jurisdiction, reporting date, currency, source records and requested decision. Obtain actual contracts/accounts and regulator evidence when needed. Label missing data rather than inventing values.',
    calculate: 'Use hivemind_calculate for decimal cash sums and balances. Keep assumptions and source values separate from results; use explicit units. Generate an editable spreadsheet with calculations and source references.',
    review: 'Trace consequential statements to actual contract clauses, source records or regulator text. Identify inconsistencies, scenario assumptions and unresolved legal questions. Explain what requires professional judgment.',
    approve: 'Present the exact proposed commitment, filing, transaction or external document. Require native approval before executing it. A review artifact may be delivered as a draft while the external action remains pending.',
    execute: 'Use the authenticated connected tool for the specifically approved operation. Retain the provider receipt. Failed or rejected operations remain incomplete and must not be described as filed, paid or signed.',
  } },
  { id: 'product-design', capabilities: ['research', 'artifact', 'connected'], workflowRef: 'native:workflow', stages: {
    discover: 'Retrieve product specifications, customer feedback and the decision to support. Separate measured pain from assumptions. Define a testable outcome.',
    design: 'Produce the requested PRD, flow, prototype or ranked backlog with actual capabilities and constraints. Use web generation for a viewable prototype and editable files for handoff.',
    validate: 'Exercise the produced artifact, assess acceptance criteria and record defects. Seek requested approval before changing live products or committing to customers.',
  } },
]

/** Register compact stage discovery and replaceable stage context through native injection. */
export function registerFieldMethods(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'hivemind_field_step',
    description: 'Load guidance for a selected field method. Omit stage to see its recommended stages. Select only stages useful to the operating plan; this tool neither executes actions nor changes todo completion. The latest selected stage replaces earlier stage guidance.',
    parameters: { method: { type: 'string', required: true, enum: FIELD_METHODS.map(m => m.id) }, stage: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      const method = FIELD_METHODS.find(m => m.id === args.method)
      if (!method) throw new Error('Select a returned field method')
      if (!args.stage) return { method: method.id, stages: Object.keys(method.stages), capabilities: [...method.capabilities], workflow_ref: method.workflowRef, instruction: 'Use native workflow only when persistence, waiting or retries are useful; inline execution is also supported.' }
      const guidance = method.stages[args.stage]
      if (!guidance) throw new Error(`Available stages: ${Object.keys(method.stages).join(', ')}`)
      if (!execution.agent) throw new Error('An active session is required')
      const text = `Current field method: ${method.id}. Stage: ${args.stage}.\n${guidance}\nFollow the current user request and operating plan. Existing tools, receipts and unresolved todos remain authoritative.`
      execution.agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'hivemind-field-method', form: 'snapshot', sections: [{ name: 'hivemind:field-stage', text }] } }))
      return { method: method.id, stage: args.stage, status: 'guidance_loaded', context_section: 'hivemind:field-stage' }
    },
  }))
}
