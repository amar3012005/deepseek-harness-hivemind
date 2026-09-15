import { useEffect, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputScopeOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './ScopeSelect.module.css'

export type HivemindReadScope = 'full' | 'personal' | 'organization' | 'project'

export interface ScopeSelectProps extends InputScopeOwnerProps {
  initialScope: HivemindReadScope
  onSelect: (sessionId: SessionId, scope: HivemindReadScope, project?: string) => void
}

/** The HIVE read lens in the native folder selector seat. Full scope is a
 * read union; writes still require a concrete approval destination. */
export function ScopeSelect({ sessionId, locked, initialScope, onSelect }: ScopeSelectProps) {
  const [scope, setScope] = useState<HivemindReadScope>(initialScope)
  const [project, setProject] = useState('')

  useEffect(() => setScope(initialScope), [initialScope])

  return <label className={css.root}>
    <span className={css.icon} aria-hidden>▱</span>
    <select
      className={css.select}
      aria-label="HIVE-MIND read scope"
      value={scope}
      disabled={locked}
      onChange={(event) => {
        const next = event.target.value as HivemindReadScope
        setScope(next)
        if (next !== 'project') {
          setProject('')
          onSelect(sessionId, next)
        }
      }}
    >
      <option value="full">Full scope</option>
      <option value="personal">Personal</option>
      <option value="organization">Organization</option>
      <option value="project">Project</option>
    </select>
    <span className={css.agent} aria-hidden>HIVE-MIND Chat</span>
    {scope === 'project' && <input
      className={css.project}
      aria-label="Authorized project"
      placeholder="Project"
      value={project}
      disabled={locked}
      onChange={event => setProject(event.target.value)}
      onBlur={() => { if (project.trim() !== '') onSelect(sessionId, 'project', project.trim()) }}
    />}
  </label>
}
