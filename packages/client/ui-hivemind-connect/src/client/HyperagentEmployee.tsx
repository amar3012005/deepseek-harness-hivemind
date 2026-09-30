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
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [options, setOptions] = useState<EmployeeOption[]>([])
  const [menuHeight, setMenuHeight] = useState(360)
  if (!isHyperagentPreset(preset)) return null
  const selected = fromLog
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
    <button className={css.pickerButton} type="button" aria-haspopup="listbox" aria-expanded={open} onClick={toggle}>
      {selected === null ? <span className={css.autoAvatar}>{t('employee.initial')}</span> : <EmployeeAvatar employee={selected} size={24} />}
      <span>{selected?.name ?? t('employee.auto')}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div className={css.menu} role="listbox" aria-label={t('employee.label')} style={{ maxHeight: menuHeight }}>
      <button type="button" role="option" aria-selected={selected === null} disabled={loading} onClick={() => { choose(null) }}><span className={css.autoAvatar}>{t('employee.initial')}</span><span><strong>{t('employee.auto')}</strong><small>{t('employee.autoDetail')}</small></span></button>
      {options.map(employee => <button key={employee.id} type="button" role="option" aria-selected={selected?.id === employee.id} disabled={loading} onClick={() => { choose(employee) }}><EmployeeAvatar employee={employee} size={34} /><span><strong>{employee.name}</strong><small>{employee.role}</small></span></button>)}
      {loading && <p role="status">{t('employee.loading')}</p>}
      {error && <p role="alert">{t('employee.unavailable')}</p>}
    </div>}
  </div>
}

type PanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'hivemind-connect'> & Pick<EmployeeInjected, 'useEmployeeEvents'>

/** Employee environment in native right-sidebar tab; previews remain native tabs. */
export function HyperagentEmployeePanel({ useSession, useEmployeeEvents, t }: PanelProps) {
  const selected = useEmployeeEvents(selectedEmployee)
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
  ensurePreview: () => boolean
  useEmployeeEvents: SnapshotSelectorHook<SessionEventWindow>
}
type ToggleProps = PropsRuntime<'conversation.session.header.corner'> & PropsLocale<'hivemind-connect'> & PanelToggleInjected

export function HyperagentPanelToggle({ sessionId, useSessions, useEmployeeEvents, swapPanel, ensurePreview, t }: ToggleProps) {
  // The HIVE app owns the conversation's far-right header seat. Keep the
  // native panel affordance there for every session; it opens Preview for
  // HyperAgents and toggles the sidebar for other presets.
  const preset = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)
  const selected = useEmployeeEvents(selectedEmployee)
  const isOsRoute = typeof window !== 'undefined' && window.location.pathname.startsWith('/hivemind/app/employee/harness/')
  const [dismissed, setDismissed] = useState(false)
  const [collision, setCollision] = useState(false)
  const [dock, setDock] = useState({ left: 0, width: 420 })
  const toggleRef = useRef<HTMLButtonElement>(null)
  const previewOpenedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!isOsRoute || !isHyperagentPreset(preset) || previewOpenedFor.current === sessionId) return
    let pending: ReturnType<typeof setTimeout> | undefined
    const openWhenMounted = () => {
      if (ensurePreview()) {
        previewOpenedFor.current = sessionId
      } else {
        pending = setTimeout(openWhenMounted, 50)
      }
    }
    openWhenMounted()
    return () => { if (pending !== undefined) clearTimeout(pending) }
  }, [isOsRoute, preset, sessionId, ensurePreview])
  useEffect(() => {
    if (!isOsRoute || !isHyperagentPreset(preset)) return
    const root = toggleRef.current?.closest<HTMLElement>('[data-phase]')
    const scroller = root?.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (!root || !scroller) return
    const measure = () => {
      const boundary = root.getBoundingClientRect()
      const inset = Math.max(0, window.innerWidth - boundary.right)
      document.documentElement.style.setProperty('--dsh-hyperagent-chat-right-inset', `${inset}px`)
      const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1
      const cardWidth = Math.min(420 * zoom, Math.max(0, boundary.width - 32 * zoom))
      const cardLeft = boundary.left + (boundary.width - cardWidth) / 2
      setDock((previous) => {
        const next = { left: cardLeft / zoom, width: cardWidth / zoom }
        return Math.abs(previous.left - next.left) < 1 && Math.abs(previous.width - next.width) < 1
          ? previous : next
      })
      if (dismissed) return
      const card = { left: cardLeft, right: cardLeft + cardWidth, top: 112 * zoom, bottom: 340 * zoom }
      const rows = scroller.querySelectorAll<HTMLElement>('[data-chat-flow] > [data-chat-flow-key]:not(:empty):not([hidden])')
      setCollision([...rows].some((row) => {
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
  }, [isOsRoute, preset, dismissed])
  const showEnvironment = isOsRoute && isHyperagentPreset(preset)
  return <>
    <button ref={toggleRef} type="button" className={css.panelToggle} aria-label={t('employee.toggle')} title={t('employee.toggle')} onClick={() => { swapPanel(isHyperagentPreset(preset)) }}><IconPanelLeftOutline16 className={css.panelToggleIcon} /></button>
    {showEnvironment && createPortal(<div
      className={css.environmentDock} style={dock} data-collapsed={dismissed || collision || undefined}
    >
      {dismissed || collision
        ? <button type="button" className={css.environmentReveal} onClick={() => { setDismissed(false); setCollision(false) }} aria-label={t('employee.environment')}>{t('employee.environment')}</button>
        : <section className={css.environment} aria-label={t('employee.environment')}>
          <header><span className={css.dots} aria-hidden="true"><span>●</span><span>●</span><span>●</span></span>{t('employee.environment')}<button type="button" onClick={() => { setDismissed(true) }}>{t('employee.hide')}</button></header>
          <div className={css.identity}>{selected === null ? <span className={css.autoAvatar}>{t('employee.initial')}</span> : <EmployeeAvatar employee={selected} size={36} />}<span><strong>{selected?.name ?? t('employee.auto')}</strong><small>{selected?.role ?? t('employee.autoDetail')}</small></span><button type="button" className={css.settings} aria-label={t('employee.settings')} title={t('employee.settings')} onClick={() => { window.location.assign('/hivemind/app/settings') }}><IconSettingsOutline16 /></button></div>
          <button type="button" className={css.connectApps} onClick={() => { window.location.assign('/hivemind/app/connectors') }}>{t('employee.connectApps')}<span aria-hidden="true">›</span></button>
          <p><a href="/hivemind/app/usage">{t('employee.creditsUsed')}</a></p>
        </section>}
    </div>, document.body)}
  </>
}
