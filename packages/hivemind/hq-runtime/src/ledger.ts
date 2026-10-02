/** Metadata supplements the native Team board; it owns no task lifecycle. */
import { parseAtInput } from '@deepseek-ai/dsh-schedule'
export interface CompanyTaskContract { readonly taskId: string; readonly dueAt: string; readonly acceptanceCriteria: readonly string[] }
export interface LedgerEvent { readonly type: string; readonly data: unknown; readonly seq?: number }
/** Trusted import of a producer event from an authenticated native Team member. */
export interface ProducerArtifactReceipt {
  readonly artifactId: string
  readonly sessionId: string
  readonly sourceSeq: number
  readonly sourceType: 'hivemind/artifact-created' | 'hivemind/generation-created'
}
/** A task correlation; producer evidence is attached by the runtime, never tool input. */
export interface TaskArtifactLinks {
  readonly taskId: string
  readonly artifactIds: readonly string[]
  readonly producerReceipts?: readonly ProducerArtifactReceipt[]
}

/**
 * Validate artifact references against committed producer events.
 * @param events - committed events of one authenticated native Team member.
 * @param taskId - native board task being fulfilled.
 * @param artifactIds - requested stored artifacts, never inferred from response prose.
 * @param sessionId - exact roster-authorized producer session.
 * @returns task links with runtime-derived producer evidence.
 */
export function verifiedArtifactLinks(
  events: readonly LedgerEvent[], taskId: string, artifactIds: readonly string[], sessionId: string,
): TaskArtifactLinks {
  if (!sessionId || !artifactIds.length || artifactIds.some(id => typeof id !== 'string' || !id)) throw new Error('hq_artifact_receipt_required')
  const producerReceipts = artifactIds.map((artifactId) => {
    const event = events.findLast(item => (item.type === 'hivemind/artifact-created' || item.type === 'hivemind/generation-created')
      && typeof item.data === 'object' && item.data !== null && (item.data as { artifactId?: unknown }).artifactId === artifactId)
    if (!event || typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) {
      throw new Error('hq_artifact_receipt_required')
    }
    return { artifactId, sessionId, sourceSeq: event.seq, sourceType: event.type as ProducerArtifactReceipt['sourceType'] }
  })
  return { taskId, artifactIds: [...artifactIds], producerReceipts }
}
export function companyTaskContract(value: unknown): CompanyTaskContract {
  if (typeof value !== 'object' || value === null) throw new Error('hq_invalid_contract')
  const input = value as Record<string, unknown>
  if (typeof input.taskId !== 'string' || !/^task-[1-9]\d*$/.test(input.taskId)) throw new Error('hq_invalid_task_id')
  if (typeof input.dueAt !== 'string') throw new Error('hq_invalid_due_at')
  let due: number
  try { due = parseAtInput(input.dueAt) } catch { throw new Error('hq_invalid_due_at') }
  const criteria = input.acceptanceCriteria
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > 20 || criteria.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000)) throw new Error('hq_invalid_acceptance_criteria')
  return { taskId: input.taskId, dueAt: new Date(due).toISOString(), acceptanceCriteria: criteria.map(item => String(item).trim()) }
}
export function taskContracts(events: readonly LedgerEvent[]): readonly CompanyTaskContract[] {
  const contracts = new Map<string, CompanyTaskContract>()
  for (const event of events) {
    if (event.type !== 'hivemind/hq-task-contract') continue
    const contract = companyTaskContract(event.data)
    if (contracts.has(contract.taskId)) throw new Error('hq_duplicate_contract_record')
    contracts.set(contract.taskId, contract)
  }
  return [...contracts.values()]
}
export function requireArtifactReceipts(events: readonly LedgerEvent[], taskId: string): void {
  const savedIds = new Set(events.flatMap((event) => {
    if (event.type !== 'hivemind/artifact-created' && event.type !== 'hivemind/generation-created') return []
    if (typeof event.data !== 'object' || event.data === null) return []
    const data = event.data as { artifactId?: unknown }
    return typeof data.artifactId === 'string' ? [data.artifactId] : []
  }))
  const record = events.findLast(event => event.type === 'hivemind/hq-task-artifacts'
    && typeof event.data === 'object' && event.data !== null
    && (event.data as { taskId?: unknown }).taskId === taskId)
  const ids = (record?.data as { artifactIds?: unknown } | undefined)?.artifactIds
  const imported = (record?.data as { producerReceipts?: unknown } | undefined)?.producerReceipts
  if (Array.isArray(imported)) for (const value of imported) {
    if (typeof value !== 'object' || value === null) continue
    const receipt = value as Partial<ProducerArtifactReceipt>
    if (typeof receipt.artifactId === 'string' && typeof receipt.sessionId === 'string' && receipt.sessionId
      && typeof receipt.sourceSeq === 'number' && Number.isSafeInteger(receipt.sourceSeq) && receipt.sourceSeq >= 0
      && (receipt.sourceType === 'hivemind/artifact-created' || receipt.sourceType === 'hivemind/generation-created')) savedIds.add(receipt.artifactId)
  }
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !savedIds.has(id))) throw new Error('hq_artifact_receipt_required')
}

/** A failed admission may be retried only when durable state proves no model/tool work was accepted. */
export function admissionFailedBeforeWork(events: readonly LedgerEvent[]): boolean {
  const pending = new Map<string, unknown[]>()
  let failedAdmission = false
  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/call'
      || event.type === 'tool/result' || event.type === 'hivemind/artifact-created' || event.type === 'hivemind/generation-created') return false
    if (typeof event.data !== 'object' || event.data === null) continue
    const data = event.data as Record<string, unknown>
    if (event.type === 'agent/inbox/spliced') {
      if (typeof data['target'] !== 'string' || typeof data['start'] !== 'number' || !Array.isArray(data['inserted'])) return false
      const messages = pending.get(data['target']) ?? []
      messages.splice(data['start'], typeof data['removedCount'] === 'number' ? data['removedCount'] : 0, ...data['inserted'])
      pending.set(data['target'], messages)
    }
    if (event.type === 'turn/end') {
      const reason = data['reason'] as { kind?: string; error?: { message?: string } } | undefined
      failedAdmission = reason?.kind === 'error' && reason.error?.message?.startsWith('Harness credit admission failed:') === true
    }
  }
  return failedAdmission && [...pending.values()].every(messages => messages.length === 0)
}
