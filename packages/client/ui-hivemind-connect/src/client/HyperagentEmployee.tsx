import { useRef, useState } from 'react'
import { Avatar } from '@humation/react'
import { humation1 } from '@humation/assets-humation-1'
import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
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

export interface PanelToggleInjected { swapPanel: (hyperagents: boolean) => void }
type ToggleProps = PropsRuntime<'conversation.session.header.corner'> & PropsLocale<'hivemind-connect'> & PanelToggleInjected

export function HyperagentPanelToggle({ sessionId, useSessions, swapPanel, t }: ToggleProps) {
  // The HIVE app owns the conversation's far-right header seat. Keep the
  // native panel affordance there for every session; it opens Preview for
  // HyperAgents and toggles the sidebar for other presets.
  const preset = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)
  return <button type="button" className={css.panelToggle} aria-label={t('employee.toggle')} title={t('employee.toggle')} onClick={() => { swapPanel(isHyperagentPreset(preset)) }}><IconPanelLeftOutline16 className={css.panelToggleIcon} /></button>
}
