/** Approved company methods are read fresh; the static global doctrine stays unchanged. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { PLAYBOOKS, type Playbook } from './catalog.ts'

/** Validate a server-approved database record before exposing its instructions. */
export function approvedLocalCatalog(rows: readonly Record<string, JsonValue>[]): readonly Playbook[] {
  const local = rows.map((row) => {
    const version = row['version']
    const body = row['body']
    if (row['status'] !== 'approved' || typeof row['method_id'] !== 'string'
      || !/^company-[a-z0-9-]{1,152}$/.test(row['method_id'])
      || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1
      || body === null || typeof body !== 'object' || Array.isArray(body))
      throw new Error('hivemind-playbooks: invalid approved local method receipt')
    const string = (key: string): string => {
      const value = body[key]
      if (typeof value !== 'string' || !value.trim()) throw new Error(`hivemind-playbooks: invalid local ${key}`)
      return value
    }
    const list = (key: string): string[] => {
      const value = body[key]
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
        throw new Error(`hivemind-playbooks: invalid local ${key}`)
      return value as string[]
    }
    const parentGlobalIds = list('parentGlobalIds')
    if (parentGlobalIds.some(id => !PLAYBOOKS.some(item => item.id === id && item.level === 'global')))
      throw new Error('hivemind-playbooks: approved local method has unknown global parent')
    return { id: row['method_id'], version: `company-${version}`, companyRevision: version, level: 'local' as const,
      title: string('title'), description: string('description'), domains: list('domains'), intents: list('intents'),
      parentGlobalIds, content: `${string('content')}\n\nApplicability and limitations: ${string('limitations')}` }
  })
  return [...PLAYBOOKS, ...local]
}
