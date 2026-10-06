import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Current registry policy governs dispatch; a frozen persona is never current authority. */
export function employeeDispatchAllowed(profile: Record<string, JsonValue> | undefined, now = Date.now()): boolean {
  if (profile === undefined || profile['status'] === 'paused' || profile['archived_at']) return false
  const rules = profile['policy_rules']
  const lifecycle = typeof rules === 'object' && rules !== null && !Array.isArray(rules) ? rules['native_lifecycle'] : undefined
  if (lifecycle === undefined) return true
  if (typeof lifecycle !== 'object' || lifecycle === null || Array.isArray(lifecycle)) return false
  if (lifecycle['version'] !== 1) return false
  if (lifecycle['phase'] !== 'active' || !['durable', 'temporary'].includes(String(lifecycle['kind']))) return false
  return lifecycle['kind'] !== 'temporary' || (typeof lifecycle['expires_at'] === 'string'
    && Date.parse(lifecycle['expires_at']) > now)
}

/** Administrator-started closeout permits evidence preservation, never business dispatch. */
export function employeeCloseoutAllowed(profile: Record<string, JsonValue> | undefined, now = Date.now()): boolean {
  if (profile === undefined || profile['status'] === 'paused' || profile['archived_at']) return false
  const rules = profile['policy_rules']
  const lifecycle = typeof rules === 'object' && rules !== null && !Array.isArray(rules) ? rules['native_lifecycle'] : undefined
  return typeof lifecycle === 'object' && lifecycle !== null && !Array.isArray(lifecycle)
    && lifecycle['version'] === 1 && ['durable', 'temporary'].includes(String(lifecycle['kind']))
    && (lifecycle['phase'] === 'closing' || (lifecycle['phase'] === 'active' && lifecycle['kind'] === 'temporary'
      && typeof lifecycle['expires_at'] === 'string' && Number.isFinite(Date.parse(lifecycle['expires_at']))
      && Date.parse(lifecycle['expires_at']) <= now))
}
export function employeeCloseoutToolAllowed(name: string, args?: unknown): boolean {
  if (name === 'hivemind_artifact_inspect') return true
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false
  const input = args as Record<string, unknown>
  if (name === 'hyperagents_memory') return input['action'] === 'recall'
    || (input['action'] === 'save' && ['learning', 'handoff'].includes(String(input['kind'])))
  return name === 'hivemind_agent_message' && input['recipient'] === 'runtime'
    && ['reply', 'update'].includes(String(input['kind']))
}
