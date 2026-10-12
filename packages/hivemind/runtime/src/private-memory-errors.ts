const recovery: Readonly<Record<string, string>> = {
  invalid_memory_content: 'Provide a nonempty title (up to 180 characters) and summary (up to 2400 characters).',
  invalid_runtime_memory_priority: 'Use an integer priority from 0 to 100.',
  invalid_runtime_memory_evidence: 'Evidence is optional. If supplied, use at most eight nonempty references of up to 300 characters.',
  invalid_runtime_memory_impact: 'Impact is optional. If supplied, use a string of up to 500 characters.',
  invalid_runtime_memory_metadata: 'Use only the documented private memory metadata fields.',
  invalid_agenda_confirmation: 'Use an actual saved user message or same-room call with user speech; do not invent user confirmation.',
  runtime_agenda_confirmation_required: 'Use an actual saved user message or same-room call with user speech; do not invent user confirmation.',
  invalid_runtime_memory_resolution: 'Recall the open record and use its exact supersedes_id to resolve or replace it.',
  invalid_supersedes_id: 'Use the exact UUID returned by private memory recall, not a title or slug.',
  superseded_memory_already_replaced: 'Recall current memory before deciding whether another update is needed.',
  memory_idempotency_conflict: 'Read existing durable memory before retrying; do not change a previously used operation key.',
  runtime_memory_required: 'These record types are available only to the authenticated Runtime room.',
  runtime_memory_scope_required: 'Use the same authenticated Runtime owner and session; do not switch identity.',
  operating_memory_unavailable: 'Private memory is unavailable; do not claim a save succeeded. Retry only after checking durable state.',
}

/** Only known business codes and static recovery hints may cross into model context. */
export function privateMemoryFailure(value: unknown): { code: string; message: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const code = (value as Record<string, unknown>)['error']
  if (typeof code !== 'string' || !Object.hasOwn(recovery, code)) return undefined
  return { code, message: `${code}: ${recovery[code]}` }
}
