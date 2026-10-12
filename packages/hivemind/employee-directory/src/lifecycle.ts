import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Current registry policy governs dispatch; a frozen persona is never current authority. */
export function employeeDispatchAllowed(profile: Record<string, JsonValue> | undefined, now = Date.now()): boolean {
  if (profile === undefined || profile['status'] === 'paused' || profile['archived_at']) return false
  const rules = profile['policy_rules']
  // Canonical roster visibility does not authorize a native DSH execution loop.
  // External employee dispatch needs its own authenticated provider admission.
  if (typeof rules === 'object' && rules !== null && !Array.isArray(rules)
    && Object.hasOwn(rules, 'open_dot_employee')) return false
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


/** A canonical Open Dot identity is externally dispatchable only through its
 * separately authenticated provider. This predicate never permits a native
 * DSH model loop for an Open Dot employee.
 */
export function employeeExternalDispatchAllowed(profile: Record<string, JsonValue> | undefined, now = Date.now()): boolean {
  if (profile === undefined || profile['status'] === 'paused' || profile['status'] === 'archived'
    || profile['archived_at'] != null || profile['archivedAt'] != null) return false
  const rules = profile['policy_rules'] ?? profile['policyRules']
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) return false
  const marker = rules['open_dot_employee'] ?? rules['openDotEmployee']
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)
    || marker['version'] !== 1 || marker['execution_backend'] !== 'open-dot'
    || marker['state'] !== 'bound' || typeof marker['dot_id'] !== 'string' || marker['dot_id'].length === 0) return false
  const lifecycle = rules['native_lifecycle'] ?? rules['nativeLifecycle']
  if (lifecycle === undefined) return true
  if (typeof lifecycle !== 'object' || lifecycle === null || Array.isArray(lifecycle)
    || lifecycle['version'] !== 1 || lifecycle['phase'] !== 'active'
    || !['durable', 'temporary'].includes(String(lifecycle['kind']))) return false
  return lifecycle['kind'] !== 'temporary' || (typeof lifecycle['expires_at'] === 'string'
    && Date.parse(lifecycle['expires_at']) > now)
}
