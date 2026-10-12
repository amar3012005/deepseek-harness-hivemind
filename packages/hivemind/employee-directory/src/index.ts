export { employeeDispatchAllowed, employeeCloseoutAllowed, employeeCloseoutToolAllowed } from './lifecycle.ts'
/** Validated HIVE-MIND employee and HyperAgent directory projections. @module @deepseek-ai/dsh-hivemind-employee-directory */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const MAX_EMPLOYEES = 100

/** Authorized directory returned for the current organization. */
export interface HyperagentDirectory {
  readonly status: 'ready'
  readonly contract: 'hivemind.hyperagent-profiles.v1'
  readonly profiles: Record<string, JsonValue>[]
  readonly count: number
  readonly generatedAt?: JsonValue
}

/** Provider resolves employees without accepting model-supplied tenant identifiers. */
export interface HiveMindEmployeeDirectoryProvider {
  profiles(signal: AbortSignal): Promise<HyperagentDirectory>
}

declare module '@deepseek-ai/cordis' {
  interface Context { hivemindEmployeeDirectory: HiveMindEmployeeDirectory }
}

/** Preset-scoped employee directory service. */
export default class HiveMindEmployeeDirectory extends Service {
  private provider: HiveMindEmployeeDirectoryProvider | undefined

  constructor(ctx: Context) { super(ctx, 'hivemindEmployeeDirectory') }

  register(provider: HiveMindEmployeeDirectoryProvider): () => void {
    if (this.provider !== undefined) throw new Error('hivemind-employee-directory: provider already registered')
    this.provider = provider
    return () => { if (this.provider === provider) this.provider = undefined }
  }

  async profiles(signal: AbortSignal): Promise<HyperagentDirectory> {
    if (this.provider === undefined) throw new Error('hivemind-employee-directory: provider is unavailable')
    return this.provider.profiles(signal)
  }
}

/** Local employee profile authorized for native subagent delegation. */
export interface EmployeeProfile {
  id: string
  name: string
  role: string
  persona: string
  allowedTools?: string[]
  model?: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`hivemind-employee-directory: ${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`hivemind-employee-directory: ${label} must be a non-empty string`)
  return value.trim()
}

/** Validate the server-scoped HyperAgent response while removing tenant fields. */
export function projectHyperagentProfiles(value: unknown): Record<string, JsonValue> {
  const outer = record(value, 'response')
  const response = outer['data'] === undefined ? outer : record(outer['data'], 'response.data')
  if (response['ok'] !== true || response['contract'] !== 'hivemind.hyperagent-profiles.v1') throw new TypeError('hivemind-employee-directory: unsupported response')
  if (!Array.isArray(response['profiles']) || response['profiles'].length > MAX_EMPLOYEES) throw new TypeError('hivemind-employee-directory: invalid profile list')
  const profiles = response['profiles'].map((entry, index) => {
    const item = record(entry, `profiles[${index}]`)
    const safe: Record<string, JsonValue> = { id: text(item['id'], `profiles[${index}].id`), name: text(item['name'], `profiles[${index}].name`), slug: text(item['slug'], `profiles[${index}].slug`) }
    for (const key of ['avatar_url','team_id','scope','status','persona','role_archetype','peer_review_targets','tools','policy_rules','persona_contract','active_prompt_version']) {
      const field = item[key]
      if (field !== undefined) safe[key] = field as JsonValue
    }
    return safe
  })
  if (response['count'] !== undefined && response['count'] !== profiles.length) throw new TypeError('hivemind-employee-directory: count mismatch')
  return { status: 'ready', contract: 'hivemind.hyperagent-profiles.v1', profiles, count: profiles.length, ...(response['generated_at'] === undefined ? {} : { generated_at: response['generated_at'] as JsonValue }) }
}

/** Convert the validated server projection into a directory service value. */
export function hyperagentDirectory(value: unknown): HyperagentDirectory {
  const projection = projectHyperagentProfiles(value)
  const profiles = projection['profiles']
  const count = projection['count']
  if (!Array.isArray(profiles) || typeof count !== 'number') throw new TypeError('hivemind-employee-directory: invalid projected directory')
  return {
    status: 'ready', contract: 'hivemind.hyperagent-profiles.v1',
    profiles: profiles as Record<string, JsonValue>[], count,
    ...(projection['generated_at'] === undefined ? {} : { generatedAt: projection['generated_at'] }),
  }
}

/** Validate a local employee registry already read through the identity adapter's secure file policy. */
export function parseEmployeeRegistry(value: unknown): EmployeeProfile[] {
  const root = record(value, 'registry')
  if (root['version'] !== 'hivemind-employees.v1' || !Array.isArray(root['employees']) || root['employees'].length > MAX_EMPLOYEES) throw new TypeError('hivemind-employee-directory: invalid registry')
  const employees = root['employees'].map((entry, index) => {
    const input = record(entry, `employees[${index}]`)
    const rawTools = input['allowedTools']
    const allowedTools = rawTools === undefined ? undefined : Array.isArray(rawTools) ? rawTools.map((tool, toolIndex) => text(tool, `employees[${index}].allowedTools[${toolIndex}]`)) : (() => { throw new TypeError('hivemind-employee-directory: allowedTools must be an array') })()
    const profile: EmployeeProfile = { id: text(input['id'], `employees[${index}].id`), name: text(input['name'], `employees[${index}].name`), role: text(input['role'], `employees[${index}].role`), persona: text(input['persona'], `employees[${index}].persona`) }
    if (allowedTools !== undefined) profile.allowedTools = allowedTools
    if (input['model'] !== undefined) profile.model = text(input['model'], `employees[${index}].model`)
    return profile
  })
  const ids = employees.map(employee => employee.id)
  if (new Set(ids).size !== ids.length) throw new TypeError('hivemind-employee-directory: employee ids must be unique')
  return employees
}
