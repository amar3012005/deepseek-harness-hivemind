const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type References = { room_id?: string; run_id?: string; trigger_id?: string; supersedes_id?: string }
/** The current native session is already recorded as context.sessionId, never a room UUID. */
export function normalizePrivateMemoryReferences(input: References, sessionId: string): References {
  const result: References = {}
  for (const field of ['room_id', 'run_id', 'trigger_id', 'supersedes_id'] as const) {
    const value = input[field]
    if (value === undefined || (field === 'room_id' && value === sessionId)) continue
    const identity = field === 'run_id' && value.startsWith('trigger-') ? value.slice(8) : value
    if (!uuid.test(identity)) throw new Error(`private memory ${field} must be an exact UUID from a receipt; omit it when unknown. Native session context is already recorded automatically.`)
    result[field] = value
  }
  return result
}
