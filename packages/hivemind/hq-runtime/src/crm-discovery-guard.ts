/** Internal application references are recovered through authorized discovery, not human lookup. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { isHqLead } from './rest.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deliberately narrow: genuine pricing, scope, connector access, and named choices remain questions. */
export function requestsInternalAppReference(value: unknown): boolean {
  if (!record(value) || typeof value.question !== 'string') return false
  const question = value.question
  return /\b(?:crm|application|app)\b/i.test(question)
    && /\b(?:uuid|app(?:lication)?[ _-]?id|internal identifier|app(?:lication)? (?:link|reference))\b/i.test(question)
    && /\b(?:share|send|provide|give|need|what is|which is|find)\b/i.test(question)
}

export function crmReferenceDenial(ctx: Context, execution: Readonly<ToolExecution>): string | undefined {
  if (execution.name !== 'ask_user_question' || !execution.agent || !isHqLead(ctx, execution.agent)
    || !record(execution.arguments) || !Array.isArray(execution.arguments.questions)
    || !execution.arguments.questions.some(requestsInternalAppReference)) return
  return 'runtime_app_reference_discovery_required: Do not ask the human to retrieve an internal CRM/application UUID or link. Lease apps with hivemind_capabilities, load create-crm, call hivemind_app_list (browse without query and follow nextCursor if necessary), then inspect the exact returned ID with hivemind_app_get. Successful discovery is read-only and does not authorize edits. If discovery is unavailable, report the actual tool/access failure to Runtime state rather than repeating an identifier question. If real named matches are ambiguous, ask which named workspace. Preserve any other genuine business questions in this rejected batch and ask those separately; no human answer was supplied or inferred.'
}

/** Native monotonic guard cannot override another policy denial or grant any capability. */
export function installCrmDiscoveryGuard(ctx: Context): void {
  ctx.effect(() => ctx.tools.guard(execution => crmReferenceDenial(ctx, execution)))
}
