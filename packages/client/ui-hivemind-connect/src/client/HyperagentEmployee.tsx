import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Avatar } from '@humation/react'
import { humation1 } from '@humation/assets-humation-1'
import { IconPanelLeftOutline16, IconSettingsOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './HyperagentEmployee.module.css'

export interface EmployeeOption {
  id: string
  name: string
  role: string
  avatarUrl?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { hyperagentOwner: string | null }
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
  return value === 'hivemind-hyperagents' || value === 'hyperagents' || value === 'hyperagents-compressed'
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
  const owner = useSessions(state => state.byId[sessionId]?.projectionValues?.hyperagentOwner)
  const started = useSessions(state => state.byId[sessionId]?.blank === false)
  const fromEventsLocked = useEmployeeEvents(employeeOwnershipLocked)
  const locked = owner != null || started || fromEventsLocked
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [options, setOptions] = useState<EmployeeOption[]>([])
  const [menuHeight, setMenuHeight] = useState(360)
  if (!isHyperagentPreset(preset)) return null
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
    }, () => { setError(true) }).finally(() => { setLoading(false) })
  }
  return <div ref={pickerRef} className={css.picker} data-hivemind-employee-picker>
    <button className={css.pickerButton} type="button" aria-haspopup="listbox" aria-expanded={open && !locked} disabled={locked} title={locked ? t('employee.ownerLocked') : undefined} onClick={toggle}>
      {selected === null ? <span className={css.autoAvatar}>{t('employee.initial')}</span> : <EmployeeAvatar employee={selected} size={24} />}
      <span>{selected?.name ?? t('employee.auto')}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && !locked && <div className={css.menu} role="listbox" aria-label={t('employee.label')} style={{ maxHeight: menuHeight }}>
      <button type="button" role="option" aria-selected={selected === null} disabled={loading} onClick={() => { choose(null) }}><span className={css.autoAvatar}>{t('employee.initial')}</span><span><strong>{t('employee.auto')}</strong><small>{t('employee.autoDetail')}</small></span></button>
      {options.map(employee => <button key={employee.id} type="button" role="option" aria-selected={selected?.id === employee.id} disabled={loading} onClick={() => { choose(employee) }}><EmployeeAvatar employee={employee} size={34} /><span><strong>{employee.name}</strong><small>{employee.role}</small></span></button>)}
      {loading && <p role="status">{t('employee.loading')}</p>}
      {error && <p role="alert">{t('employee.unavailable')}</p>}
    </div>}
  </div>
}

type PanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'hivemind-connect'> & Pick<EmployeeInjected, 'useEmployeeEvents'>

/** Employee environment in native right-sidebar tab; previews remain native tabs. */
export function HyperagentEmployeePanel({ sessionId, useSessions, useSession, useEmployeeEvents, t }: PanelProps) {
  const owner = useSessions(state => state.byId[sessionId]?.projectionValues?.hyperagentOwner)
  const fromLog = useEmployeeEvents(selectedEmployee)
  const selected = owner == null ? fromLog : projectedEmployee(owner)
  const running = useSession(state => state.running)
  return <div className={css.panel}>
    <section className={css.environment} aria-label={t('employee.environment')}>
      <header><span className={css.dots} aria-hidden="true">● ● ●</span>{t('employee.environment')}</header>
      <div className={css.identity}>{selected === null ? <span className={css.autoAvatar}>{t('employee.initial')}</span> : <EmployeeAvatar employee={selected} size={36} />}<span><strong>{selected?.name ?? t('employee.auto')}</strong><small>{selected?.role ?? t('employee.autoDetail')}</small></span></div>
      <p>{running ? t('employee.working') : t('employee.ready')}</p>
    </section>
  </div>
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
  const owner = useSessions(state => state.byId[sessionId]?.projectionValues?.hyperagentOwner)
  const fromLog = useEmployeeEvents(selectedEmployee)
  const selected = owner == null ? fromLog : projectedEmployee(owner)
  const isOsRoute = typeof window !== 'undefined' && window.location.pathname.startsWith('/hivemind/app/employee/harness/')
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
    if (!isOsRoute || !isHyperagentPreset(preset)) return
    const root = toggleRef.current?.closest<HTMLElement>('[data-phase]')
    const scroller = root?.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (!root || !scroller) return
    const measure = () => {
      const boundary = root.getBoundingClientRect()
      const inset = Math.max(0, window.innerWidth - boundary.right)
      document.documentElement.style.setProperty('--dsh-hyperagent-chat-right-inset', `${inset}px`)
      document.documentElement.style.setProperty('--dsh-hyperagent-header-controls-width', '328px')
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
      document.documentElement.style.removeProperty('--dsh-hyperagent-header-controls-width')
    }
  }, [isOsRoute, preset, dismissed])
  const showEnvironment = isOsRoute && isHyperagentPreset(preset)
  return <>
    {showEnvironment && <button type="button" className={css.environmentTrigger} onClick={() => { setDismissed(value => !value) }} aria-label={t('employee.environment')} aria-expanded={!dismissed && !collision} title={t('employee.environment')}><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="7" cy="5" r="2" fill="var(--dsw-surface-primary, #fff)" stroke="currentColor" strokeWidth="1.5"/><circle cx="13" cy="10" r="2" fill="var(--dsw-surface-primary, #fff)" stroke="currentColor" strokeWidth="1.5"/><circle cx="8" cy="15" r="2" fill="var(--dsw-surface-primary, #fff)" stroke="currentColor" strokeWidth="1.5"/></svg></button>}
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
