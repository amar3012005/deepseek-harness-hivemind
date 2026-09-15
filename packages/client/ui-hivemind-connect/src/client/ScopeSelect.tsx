import { useEffect, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './ScopeSelect.module.css'

export type HivemindReadScope = 'full' | 'personal' | 'organization' | 'project'

interface ProjectOption {
  id: string
  name: string
  slug: string
}

export interface ScopeSelectProps {
  sessionId: SessionId
  locked?: boolean
  initialScope: HivemindReadScope
  initialProject?: string
  onSelect: (sessionId: SessionId, scope: HivemindReadScope, project?: string) => void
}

/** The HIVE read lens in the blank-session hero. Full scope is a read union;
 * writes still require a concrete approval destination. */
export function ScopeSelect({ sessionId, locked = false, initialScope, initialProject, onSelect }: ScopeSelectProps) {
  const [scope, setScope] = useState<HivemindReadScope>(initialScope)
  const [project, setProject] = useState(initialProject ?? '')
  const [projects, setProjects] = useState<ProjectOption[]>()
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [projectError, setProjectError] = useState<string>()

  useEffect(() => setScope(initialScope), [initialScope])
  useEffect(() => setProject(initialProject ?? ''), [initialProject])

  const openProjectPicker = async (): Promise<void> => {
    if (projects !== undefined || loadingProjects) return
    setLoadingProjects(true)
    setProjectError(undefined)
    try {
      const response = await fetch('/api/hivemind/projects', { credentials: 'include' })
      if (!response.ok) throw new Error('project catalog unavailable')
      const body = await response.json() as { projects?: ProjectOption[] }
      const next = Array.isArray(body.projects)
        ? body.projects.filter((row): row is ProjectOption => typeof row?.id === 'string' && typeof row.name === 'string' && typeof row.slug === 'string')
        : []
      setProjects(next)
      if (next.length === 0) setProjectError('No authorized projects are available.')
    } catch {
      setProjectError('Project list is unavailable. Your scope was not changed.')
    } finally {
      setLoadingProjects(false)
    }
  }

  return <label className={css.root}>
    <span className={css.icon} aria-hidden>
      <svg viewBox="0 0 24 24" focusable="false"><path d="M3.5 6.75A2.25 2.25 0 0 1 5.75 4.5h4l1.75 2h6.75A2.25 2.25 0 0 1 20.5 8.75v8.5a2.25 2.25 0 0 1-2.25 2.25H5.75A2.25 2.25 0 0 1 3.5 17.25v-10.5Z" /></svg>
    </span>
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
        } else {
          void openProjectPicker()
        }
      }}
    >
      <option value="full">Choose your workspace</option>
      <option value="personal">Personal</option>
      <option value="organization">Organization</option>
      <option value="project">Project</option>
    </select>
    <span className={css.agent} aria-hidden>HIVE-MIND Chat</span>
    {scope === 'project' && <select
      className={css.project}
      aria-label="Authorized project"
      value={project}
      disabled={locked}
      onChange={(event) => {
        const projectId = event.target.value
        setProject(projectId)
        if (projectId !== '') onSelect(sessionId, 'project', projectId)
      }}
    >
      <option value="">{loadingProjects ? 'Loading projects…' : 'Choose project'}</option>
      {(projects ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>}
    {scope === 'project' && projectError !== undefined && <span className={css.error} role="status">{projectError}</span>}
  </label>
}
