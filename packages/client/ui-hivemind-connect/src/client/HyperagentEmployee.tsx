import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Avatar } from '@humation/react'
import { humation1 } from '@humation/assets-humation-1'
import { IconPanelLeftOutline16, IconSettingsOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './HyperagentEmployee.module.css'
import { workbenchSnapshot } from './HyperagentWorkbench.tsx'

export interface EmployeeOption {
  id: string
  name: string
  role: string
  avatarUrl?: string
  allowedTools?: string[]
  persona?: string
  createdAt?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    hyperagentOwner: string | null
    hyperagentSelection: string | null
    hyperagentLatestMessage: string | null
  }
}

/** The owner projection survives pagination and direct cold-session reload. */
export function projectedEmployee(value: string | null | undefined): EmployeeOption | null {
  if (value == null) return null
  try {
    const owner = JSON.parse(value) as { id: string | null; name: string; role: string; avatarUrl?: string }
    return owner.id === null ? null : {
      id: owner.id, name: owner.name, role: owner.role, ...(owner.avatarUrl ? { avatarUrl: owner.avatarUrl } : {}),
    }
  } catch { return null }
}

const laneColors: Record<string, string> = {
  strategist: '#a855f7', coordinator: '#a855f7', builder: '#117dff', skeptic: '#f59e0b',
  investigator: '#10b981', researcher: '#10b981', generalist: '#ec4899', communicator: '#ec4899',
}

/** The same animated Runtime portrait used by the outer sidebar. */
export function RuntimeAvatar({ size }: { size: number }) {
  return <img src="/assets/runtime-computer-c2305f5b.webp?v=c2305f5b" alt="Runtime" width={size} height={size}
    style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0, mixBlendMode: 'multiply', filter: 'brightness(1.08)' }} />
}

/** Reuse production FE Humation seed, asset and role-color mapping. */
export function EmployeeAvatar({ employee, size }: { employee: EmployeeOption; size: number }) {
  const color = laneColors[employee.role.toLowerCase()] ?? '#ec4899'
  return <span className={css.avatar} style={{ width: size, height: size, background: `color-mix(in srgb, ${color} 10%, transparent)`, boxShadow: `0 0 0 1.5px ${color}22` }}>
    {employee.avatarUrl?.startsWith('https://')
      ? <img src={employee.avatarUrl} alt="" width={size} height={size} />
      : <Avatar assets={humation1} seed={employee.id} size={size} colors={{ clothes: color }} background="transparent" title={employee.name} />}
  </span>
}

export function selectedEmployee(window: SessionEventWindow): EmployeeOption | null {
  const owner = window.entries.find(entry => entry.type === 'event' && (entry.event.type as string) === 'hivemind/session-owner')
  if (owner?.type === 'event') {
    const value = owner.event.data as { id: string | null; name: string; role: string; avatarUrl?: string }
    return value.id === null ? null : {
      id: value.id, name: value.name, role: value.role, ...(value.avatarUrl ? { avatarUrl: value.avatarUrl } : {}),
    }
  }
  for (let index = window.entries.length - 1; index >= 0; index -= 1) {
    const entry = window.entries[index]
    if (entry?.type !== 'event' || (entry.event.type as string) !== 'hivemind/employee-selection') continue
    const value = entry.event.data as { id: string | null; name?: string; role?: string; avatarUrl?: string }
    return value.id === null ? null : {
      id: value.id, name: value.name ?? value.id, role: value.role ?? 'employee',
      ...(typeof value.avatarUrl === 'string' ? { avatarUrl: value.avatarUrl } : {}),
    }
  }
  return null
}

export function employeeOwnershipLocked(window: SessionEventWindow): boolean {
  return window.entries.some(entry => entry.type === 'event' && ['hivemind/session-owner', 'turn/start'].includes(entry.event.type as string))
}

export function isHyperagentPreset(value: unknown): boolean {
  return value === 'hivemind-hq' || value === 'hivemind-hyperagents' || value === 'hyperagents' || value === 'hyperagents-compressed'
}

export function employeeMenuHeight(viewportHeight: number, triggerBottom: number): number {
  return Math.max(0, Math.min(360, viewportHeight - triggerBottom - 16))
}

export interface EmployeeInjected {
  useEmployeeEvents: SnapshotSelectorHook<SessionEventWindow>
  listEmployees: () => Promise<EmployeeOption[]>
  selectEmployee: (id: string | null) => Promise<boolean>
}

type PickerProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'hivemind-connect'> & EmployeeInjected

/** Downward-opening selector beside native Workspace Write control. */
export function HyperagentEmployeePicker({ sessionId, useSessions, useEmployeeEvents, listEmployees, selectEmployee, t }: PickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null)
  const preset = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)
  const fromLog = useEmployeeEvents(selectedEmployee)
  const owner = useSessions(state =>
    (state.byId[sessionId]?.projectionValues?.hyperagentOwner ?? state.byId[sessionId]?.projectionValues?.hyperagentSelection))
  const started = useSessions(state => state.byId[sessionId]?.blank === false)
  const fromEventsLocked = useEmployeeEvents(employeeOwnershipLocked)
  // Switching now navigates to the other employee's room; it never reassigns this owner.
  const locked = false
  void started; void fromEventsLocked
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<boolean | string>(false)
  const [options, setOptions] = useState<EmployeeOption[]>([])
  const [menuHeight, setMenuHeight] = useState(360)
  if (!isHyperagentPreset(preset) && locked) return null
  const selected = owner == null ? fromLog : projectedEmployee(owner)
  const toggle = (): void => {
    if (!open) setMenuHeight(employeeMenuHeight(window.innerHeight, pickerRef.current?.getBoundingClientRect().bottom ?? 0))
    if (!open && options.length === 0) {
      setLoading(true)
      void listEmployees().then(setOptions, () => { setError(true) }).finally(() => { setLoading(false) })
    }
    setOpen(!open)
  }
  const choose = (employee: EmployeeOption | null): void => {
    setLoading(true)
    void selectEmployee(employee?.id ?? null).then((ok) => {
      if (ok) { setOpen(false); setError(false) }
      else setError(true)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : true) }).finally(() => { setLoading(false) })
  }
  return <div ref={pickerRef} className={css.picker} data-hivemind-employee-picker>
    <button className={css.pickerButton} type="button" aria-haspopup="listbox" aria-expanded={open && !locked} disabled={locked} title={locked ? t('employee.ownerLocked') : undefined} onClick={toggle}>
      {selected === null ? <span className={css.autoAvatar}>{t('employee.initial')}</span> : <EmployeeAvatar employee={selected} size={24} />}
      <span>{selected?.name ?? (isHyperagentPreset(preset) ? t('employee.auto') : 'HIVEMIND')}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && !locked && <div className={css.menu} role="listbox" aria-label={t('employee.label')} style={{ maxHeight: menuHeight }}>
      <button type="button" role="option" onClick={() => { choose(null) }} disabled={loading}><span className={css.autoAvatar}>H</span><span><strong>HIVEMIND</strong><small>Ask your company brain</small></span></button>

      {options.map(employee => <button key={employee.id} type="button" role="option" aria-selected={selected?.id === employee.id} disabled={loading} onClick={() => { choose(employee) }}><EmployeeAvatar employee={employee} size={34} /><span><strong>{employee.name}</strong><small>{employee.role}</small></span></button>)}
      {loading && <p role="status">{t('employee.loading')}</p>}
      {error && <p role="alert">{typeof error === 'string' ? error : t('employee.unavailable')}</p>}
    </div>}
  </div>
}

export interface AgentRoutine {
  id: string
  title: string
  kind: string
  active: boolean
  next: string
  toggle: (active: boolean) => Promise<void>
}
type PanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'hivemind-connect'> & Pick<EmployeeInjected, 'useEmployeeEvents'> & {
  listEmployees: () => Promise<EmployeeOption[]>
  listRoutines: () => Promise<AgentRoutine[]>
  selectArtifact: (id: string) => void
  openSession: (id: string) => void
}

/** Real session-owned work and files, using existing native management APIs. */
export function HyperagentEmployeePanel({
  sessionId, useSessions, useSession, useEmployeeEvents, listRoutines, listEmployees, selectArtifact, openSession,
}: PanelProps) {
  const owner = useSessions(state =>
    (state.byId[sessionId]?.projectionValues?.hyperagentOwner ?? state.byId[sessionId]?.projectionValues?.hyperagentSelection))
  const fromLog = useEmployeeEvents(selectedEmployee)
  const selected = projectedEmployee(owner) ?? fromLog
  const running = useSession(state => state.running)
  const jobs = useSessions(state => state.jobsBySession[sessionId] ?? [])
  const history = useSessions(state => state.ids.flatMap((id) => {
    if (id === sessionId) return []
    const row = state.byId[id]
    if ((row?.projectionValues?.agentPreset ?? row?.agentPreset) !== 'hivemind-hyperagents') return []
    if (projectedEmployee(
      (row?.projectionValues?.hyperagentOwner ?? row?.projectionValues?.hyperagentSelection))?.id !== selected?.id) return []
    return [{ id, title: row?.title ?? row?.displayTitle ?? 'Earlier conversation' }]
  }))
  const files = useEmployeeEvents(workbenchSnapshot).artifacts
  const [profile, setProfile] = useState<EmployeeOption>()
  const latest = useSessions(state => state.byId[sessionId]?.projectionValues?.hyperagentLatestMessage)
  let latestText: string | undefined
  try { if (latest) latestText = (JSON.parse(latest) as { text?: string }).text } catch { /* No saved preview. */ }
  useEffect(() => {
    let active = true
    setProfile(undefined)
    void listEmployees().then((rows) => { if (active) setProfile(rows.find(row => row.id === selected?.id)) }, () => {})
    return () => { active = false }
  }, [selected?.id, listEmployees])
  const [routines, setRoutines] = useState<AgentRoutine[]>([])
  const [accounts, setAccounts] = useState<{ id: string; toolkit: string }[]>([])
  const [error, setError] = useState('')
  const [pending, setPending] = useState<string>()
  useEffect(() => {
    let active = true
    void listRoutines().then((value) => { if (active) setRoutines(value) }, () => { if (active) setError('Routines could not be loaded.') })
    const controller = new AbortController()
    void fetch('/hivemind/dreamer/connectors', { credentials: 'include', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('apps unavailable')
      const value = await response.json() as { accounts: { id: string; toolkit: string }[] }
      if (active) setAccounts(value.accounts)
    }).catch(() => { if (active) setError('Connected apps could not be loaded.') })
    return () => { active = false; controller.abort() }
  }, [sessionId, listRoutines])
  const toggle = async (routine: AgentRoutine, value: boolean) => {
    setPending(routine.id); setError('')
    try { await routine.toggle(value); setRoutines(await listRoutines()) }
    catch { setError('The routine could not be updated. Its saved state is unchanged.') }
    finally { setPending(undefined) }
  }
  return <aside className={css.agentDetails} aria-label="Agent details">
    <div className={css.agentBiography}>{selected ? <EmployeeAvatar employee={selected} size={112} /> : <RuntimeAvatar size={112} />}<span><strong>{selected?.name ?? 'Run Time'}</strong>{!selected && <small>AI Chief of Staff</small>}<small>{running ? 'Working' : 'Ready'}</small></span></div>
    <section><h3>Biography</h3>{profile?.persona && <p className={css.personaText}>{profile.persona}</p>}{profile?.createdAt && <p>Joined {new Date(profile.createdAt).toLocaleDateString()}</p>}<p>{selected?.role ?? 'Coordinates company work and the team.'}</p></section>
    <section><h3>Active tasks</h3>{running && <p>Working on your latest request</p>}{jobs.filter(job => job.status === 'running' || job.status === 'stopping').map(job => <p key={job.id}>{job.label ?? job.status}</p>)}{!running && !jobs.some(job => job.status === 'running' || job.status === 'stopping') && <p>No active work</p>}{routines.filter(task => task.kind === 'at' && task.active).map(task => <p key={task.id}>{task.title}</p>)}</section>
    <section><h3>Routines</h3>{routines.filter(task => task.kind !== 'at').map(task => <label className={css.routineRow} key={task.id}><span>{task.title}<small>{new Date(task.next).toLocaleString()}</small></span><input type="checkbox" role="switch" checked={task.active} disabled={pending !== undefined} onChange={(event) => { void toggle(task, event.target.checked) }} aria-label={task.title} /></label>)}{!routines.some(task => task.kind !== 'at') && <p>No routines yet</p>}</section>
    <section><h3>Connected apps and permissions</h3>{profile?.allowedTools && <p>Configured tools: {profile.allowedTools.length > 0 ? profile.allowedTools.join(', ') : 'None'}</p>}{accounts.map(account => <a className={css.detailFile} key={account.id} href="/hivemind/app/connectors"><img src={`https://logos.composio.dev/api/${encodeURIComponent(account.toolkit)}`} width="20" height="20" alt="" />{account.toolkit}<small>Manage permissions ↗</small></a>)}{accounts.length === 0 && <a href="/hivemind/app/connectors">Connect an app</a>}</section>
    <section><h3>Latest work</h3><p>{latestText ?? 'No completed work in this room yet'}</p></section>
    <section><h3>Files and deliverables</h3>{files.map(file => <button className={css.detailFile} type="button" key={file.id} onClick={() => { selectArtifact(file.id) }}>▧ {file.title}</button>)}{files.length === 0 && <p>No files in the loaded conversation</p>}</section>
    {history.length > 0 && <details><summary>Earlier conversations</summary>{history.map(room => <button className={css.detailFile} type="button" key={room.id} onClick={() => { openSession(room.id) }}>{room.title}</button>)}</details>}
    {error && <p role="alert">{error}</p>}
  </aside>
}

export interface PanelToggleInjected {
  swapPanel: (hyperagents: boolean) => void
  closePreview: () => boolean
  useEmployeeEvents: SnapshotSelectorHook<SessionEventWindow>
}
type ToggleProps = PropsRuntime<'conversation.session.header.corner'> & PropsLocale<'hivemind-connect'> & PanelToggleInjected

export function HyperagentPanelToggle({ sessionId, useSessions, useEmployeeEvents, swapPanel, closePreview, t }: ToggleProps) {
  // The HIVE app owns the conversation's far-right header seat. Keep the
  // native panel affordance there for every session; it opens Preview for
  // HyperAgents and toggles the sidebar for other presets.
  const preset = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)
  const blank = useSessions(state => state.byId[sessionId]?.blank)
  const owner = useSessions(state =>
    (state.byId[sessionId]?.projectionValues?.hyperagentOwner ?? state.byId[sessionId]?.projectionValues?.hyperagentSelection))
  const fromLog = useEmployeeEvents(selectedEmployee)
  const selected = owner == null ? fromLog : projectedEmployee(owner)
  const isOsRoute = isHyperagentPreset(preset) || (typeof window !== 'undefined' && window.location.pathname.startsWith('/hivemind/app/employee/harness/'))
  // Embedded app sessions use BrainConnections as the single Environment owner.
  const sharedEnvironment = typeof window !== 'undefined' && window.location.pathname.startsWith('/hivemind/app/')
  const [dismissed, setDismissed] = useState(false)
  const [collision, setCollision] = useState(false)
  const [dock, setDock] = useState<{ left: number; width: number } | null>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const previewClosedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!isOsRoute || !isHyperagentPreset(preset) || blank !== true || previewClosedFor.current === sessionId) return
    let pending: ReturnType<typeof setTimeout> | undefined
    const closeWhenMounted = () => {
      if (closePreview()) {
        previewClosedFor.current = sessionId
      } else {
        pending = setTimeout(closeWhenMounted, 50)
      }
    }
    closeWhenMounted()
    return () => { if (pending !== undefined) clearTimeout(pending) }
  }, [isOsRoute, preset, blank, sessionId, closePreview])
  useEffect(() => {
    if (sharedEnvironment || !isOsRoute || !isHyperagentPreset(preset)) return
    const root = toggleRef.current?.closest<HTMLElement>('[data-phase]')
    const scroller = root?.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (!root || !scroller) return
    const measure = () => {
      const boundary = root.getBoundingClientRect()
      const inset = Math.max(0, window.innerWidth - boundary.right)
      document.documentElement.style.setProperty('--dsh-hyperagent-chat-right-inset', `${inset}px`)
      const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1
      const cardWidth = Math.min(320 * zoom, Math.max(0, boundary.width - 32 * zoom))
      const cardLeft = boundary.right - cardWidth - 24 * zoom
      setDock((previous) => {
        const next = { left: cardLeft / zoom, width: cardWidth / zoom }
        return previous !== null && Math.abs(previous.left - next.left) < 1 && Math.abs(previous.width - next.width) < 1
          ? previous : next
      })
      const composer = root.querySelector<HTMLElement>('[data-composer-card]')
      const composerBox = composer?.getBoundingClientRect()
      const crossesComposer = composerBox !== undefined
        && cardLeft < composerBox.right - cardWidth / 4 && cardLeft + cardWidth > composerBox.left
      const card = { left: cardLeft, right: cardLeft + cardWidth, top: 108 * zoom, bottom: 300 * zoom }
      const rows = scroller.querySelectorAll<HTMLElement>('[data-chat-flow] > [data-chat-flow-key]:not(:empty):not([hidden])')
      setCollision(crossesComposer || [...rows].some((row) => {
        const box = row.getBoundingClientRect()
        return box.right > card.left && box.left < card.right && box.bottom > card.top && box.top < card.bottom
      }))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(scroller)
    let pendingFrame = 0
    const mutationObserver = new MutationObserver(() => {
      if (pendingFrame === 0) pendingFrame = requestAnimationFrame(() => { pendingFrame = 0; measure() })
    })
    mutationObserver.observe(scroller, { childList: true, subtree: true })
    scroller.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    const frame = requestAnimationFrame(measure)
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(pendingFrame)
      observer.disconnect()
      mutationObserver.disconnect()
      scroller.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      document.documentElement.style.removeProperty('--dsh-hyperagent-chat-right-inset')
    }
  }, [sharedEnvironment, isOsRoute, preset, dismissed])
  const showEnvironment = !sharedEnvironment && isOsRoute && isHyperagentPreset(preset)
  return <>
    {showEnvironment && <button type="button" className={css.environmentTrigger} data-hivemind-environment-trigger="" onClick={() => { setDismissed(value => !value) }} aria-label={t('employee.environment')} aria-expanded={!dismissed && !collision} title={t('employee.environment')}><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="7" cy="5" r="2" fill="var(--dsw-surface-primary, #fff)" stroke="currentColor" strokeWidth="1.5"/><circle cx="13" cy="10" r="2" fill="var(--dsw-surface-primary, #fff)" stroke="currentColor" strokeWidth="1.5"/><circle cx="8" cy="15" r="2" fill="var(--dsw-surface-primary, #fff)" stroke="currentColor" strokeWidth="1.5"/></svg></button>}
    <button ref={toggleRef} type="button" className={css.panelToggle} aria-label={t('employee.toggle')} title={t('employee.toggle')} onClick={() => { swapPanel(isHyperagentPreset(preset)) }}><IconPanelLeftOutline16 className={css.panelToggleIcon} /></button>
    {showEnvironment && !dismissed && !collision && dock !== null && createPortal(<div
      className={css.environmentDock}
      style={{ left: dock.left, width: dock.width }}
    >
      <section className={css.environment} aria-label={t('employee.environment')}>
        <header><span className={css.dots} aria-hidden="true"><span>●</span><span>●</span><span>●</span></span>{t('employee.environment')}<button type="button" onClick={() => { setDismissed(true) }}>{t('employee.hide')}</button></header>
        <div className={css.identity}>{selected === null ? <span className={css.autoAvatar}>{t('employee.initial')}</span> : <EmployeeAvatar employee={selected} size={36} />}<span><strong>{selected?.name ?? t('employee.auto')}</strong><small>{selected?.role ?? t('employee.autoDetail')}</small></span><button type="button" className={css.settings} aria-label={t('employee.settings')} title={t('employee.settings')} onClick={() => { window.location.assign('/hivemind/app/settings') }}><IconSettingsOutline16 /></button></div>
        <button type="button" className={css.connectApps} onClick={() => { window.location.assign('/hivemind/app/connectors') }}>{t('employee.connectApps')}<span aria-hidden="true">›</span></button>
        <p><a href="/hivemind/app/usage">{t('employee.creditsUsed')}</a></p>
      </section>
    </div>, document.body)}
  </>
}

/** A teammate identity above the conversation; opening details never starts a task. */
export function AgentRoomHeading({ sessionId, useSessions, useSession, useEmployeeEvents, showDetails }: PropsRuntime<'conversation.room.header'> & Pick<EmployeeInjected, 'useEmployeeEvents'> & { showDetails: () => void }) {
  const value = useSessions(state =>
    (state.byId[sessionId]?.projectionValues?.hyperagentOwner ?? state.byId[sessionId]?.projectionValues?.hyperagentSelection))
  const fromLog = useEmployeeEvents(selectedEmployee)
  const employee = projectedEmployee(value) ?? fromLog
  const running = useSession(state => state.running)
  if (!window.location.pathname.startsWith('/hivemind/app/employee/harness')) return null
  return <div className={css.roomHeading} data-agent-room><span>{employee ? <EmployeeAvatar employee={employee} size={36} /> : <span className={css.autoAvatar}>R</span>}</span><span><strong>{employee?.name ?? 'Run Time'}</strong><small>{running ? 'Working' : 'Ready'}</small></span><button type="button" onClick={showDetails}>Agent details</button></div>
}
