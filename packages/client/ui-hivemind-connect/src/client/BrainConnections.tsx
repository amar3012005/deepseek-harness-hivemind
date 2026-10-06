import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState } from 'react'
import { roomIdentity } from './room-identity.ts'
import { SessionCredits } from './SessionCredits.tsx'
import css from './DreamingConnectors.module.css'
import { EmployeeAvatar, RuntimeAvatar, projectedEmployee } from './HyperagentEmployee.tsx'
const names: Record<string, string> = { googlecalendar: 'Google Calendar', gmail: 'Gmail', slack: 'Slack', googledocs: 'Google Docs', googledrive: 'Google Drive', github: 'GitHub', notion: 'Notion', outlook: 'Outlook' }
export function BrainConnections({ sessionId, useSessions, environmentActivity, showDetails, isPreviewOpen, hero = false }: PropsRuntime<'conversation.session.header.utilities'> & { hero?: boolean; showDetails: () => void; isPreviewOpen?: () => boolean }) {
  const preset = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset ?? state.byId[sessionId]?.agentPreset)
  const employee = useSessions(state => projectedEmployee(
    (state.byId[sessionId]?.projectionValues?.hyperagentOwner ?? state.byId[sessionId]?.projectionValues?.hyperagentSelection)))
  const ownerValue = useSessions(state => state.byId[sessionId]?.projectionValues?.hyperagentOwner
    ?? state.byId[sessionId]?.projectionValues?.hyperagentSelection)
  const identity = roomIdentity(preset, ownerValue)
  const busy = useSessions(state => (state.jobsBySession[sessionId] ?? []).some(job => job.status === 'running' || job.status === 'stopping'))
  const running = useSessions(state => state.byId[sessionId]?.running === true)
  const nativeChatRoute = /^\/hivemind\/app\/(?:overview|employee\/harness)(?:\/(?:new|session\/[^/]+))?\/?$/u
    .test(window.location.pathname)
  const [compact, setCompact] = useState(() => (window.matchMedia?.('(max-width: 900px)').matches ?? false))
  const [open, setOpen] = useState(() => !nativeChatRoute || !(window.matchMedia?.('(max-width: 900px)').matches ?? false))
  const controlRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 900px)')
    if (!query) return
    const resize = () => { setCompact(query.matches); if (nativeChatRoute && query.matches) setOpen(false) }
    query.addEventListener('change', resize)
    return () => query.removeEventListener('change', resize)
  }, [nativeChatRoute])
  useEffect(() => {
    if (!nativeChatRoute || !compact || !open) return
    const previous = document.activeElement as HTMLElement | null
    const focusable = () => [...(controlRef.current?.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="dialog"] a[href], [role="dialog"] input, [role="dialog"] select') ?? [])]
      .filter(element => !element.hasAttribute('disabled'))
    focusable()[0]?.focus()
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
      if (event.key === 'Tab') {
        const elements = focusable(); const first = elements[0]; const last = elements.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', dismiss)
    return () => { document.removeEventListener('keydown', dismiss); (controlRef.current?.querySelector<HTMLButtonElement>('button') ?? previous)?.focus() }
  }, [nativeChatRoute, compact, open])
  const [appsOpen, setAppsOpen] = useState(true)
  const [wideOpen, setWideOpen] = useState(false)
  const [preview, setPreview] = useState({ open: false, wide: false, inset: 0, available: 0 })
  const [accounts, setAccounts] = useState<{ id: string; toolkit: string }[]>()
  const [error, setError] = useState(false)
  const dreaming = window.location.pathname.endsWith('/dreaming') || new URLSearchParams(window.location.search).has('dreamingParent')
  const hyperagents = preset === 'hivemind-hq' || preset === 'hivemind-hyperagents' || preset === 'hyperagents' || preset === 'hyperagents-compressed' || window.location.pathname.startsWith('/hivemind/app/employee/harness')
  const brain = preset === 'hivemind-chat' || (preset == null && document.documentElement.dataset.dshMode === 'hivemind-chat')
  useEffect(() => {
    if ((!brain && !hyperagents) || dreaming) return
    const controller = new AbortController()
    const load = () => {
      void fetch('/hivemind/dreamer/connectors', { credentials: 'include', signal: controller.signal })
        .then(async (response) => { if (!response.ok) throw new Error('load'); const value = await response.json() as { accounts: { id: string; toolkit: string }[] }; if (!controller.signal.aborted) { setAccounts(value.accounts); setError(false) } })
        .catch(() => { if (!controller.signal.aborted) setError(true) })
    }
    load(); window.addEventListener('focus', load)
    return () => { controller.abort(); window.removeEventListener('focus', load) }
  }, [brain, hyperagents, dreaming])
  useEffect(() => {
    let panel: HTMLElement | null = null
    const measure = () => {
      const visible = panel?.hasAttribute('data-sidebar-right-open') === true && (isPreviewOpen?.() ?? true)
      const bounds = panel?.getBoundingClientRect()
      const width = bounds?.width ?? 0
      // Native DOM bounds include CSS zoom; fixed style coordinates do not.
      const scale = panel && panel.offsetWidth > 0 ? width / panel.offsetWidth : 1
      setPreview((previous) => {
        const next = { open: visible, wide: visible && width + 0.5 >= window.innerWidth * 0.45,
          available: visible ? Math.max(0, (bounds?.left ?? 0) / (scale || 1) - 16) : 0,
          inset: visible ? Math.max(0, window.innerWidth - (bounds?.left ?? window.innerWidth)) / (scale || 1) : 0 }
        return previous.open === next.open && previous.wide === next.wide
          && previous.inset === next.inset && previous.available === next.available ? previous : next
      })
    }
    const resize = new ResizeObserver(measure)
    const mutation = new MutationObserver(measure)
    const bind = () => {
      const next = document.querySelector<HTMLElement>('[data-sidebar-right-panel]')
      if (next !== panel) {
        resize.disconnect(); mutation.disconnect(); panel?.removeEventListener('transitionend', measure); panel = next
        if (panel) {
          resize.observe(panel)
          panel.addEventListener('transitionend', measure)
          mutation.observe(panel, { attributes: true, attributeFilter: ['data-sidebar-right-open'], childList: true, subtree: true })
        }
      }
      measure()
    }
    // Native panel mounts lazily; follow its lifecycle rather than polling.
    const mounts = new MutationObserver(bind)
    mounts.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', measure)
    bind()
    return () => { panel?.removeEventListener('transitionend', measure); resize.disconnect(); mutation.disconnect(); mounts.disconnect(); window.removeEventListener('resize', measure) }
  }, [sessionId, isPreviewOpen])
  useEffect(() => { setWideOpen(false) }, [preview.wide])
  const showApps = appsOpen && !preview.open
  const showPanel = open && (nativeChatRoute && compact || !preview.wide || wideOpen)
  if ((!brain && !hyperagents) || dreaming) return null
  const content = <>
    <div className={css.environmentHeading}><span className={css.dots} aria-hidden="true"><i /><i /><i /></span><span>Environment</span><button type="button" onClick={() => { setOpen(false); setWideOpen(false) }}>Hide</button></div>
    <div className={css.identity}>
      {employee ? <EmployeeAvatar employee={employee} size={40} />
        : hyperagents ? <RuntimeAvatar size={52} /> : <span className={css.avatar}>H</span>}
      <span><strong>{identity?.name ?? (hyperagents ? 'Runtime' : 'HIVEMIND-Chat')}</strong><small>{identity?.role ?? (hyperagents ? 'AI Chief of Staff' : 'Your company brain')}</small>{hyperagents && <small className={css.agentStatus}><i className={running || busy ? css.workingDot : css.readyDot} aria-hidden="true" />{running || busy ? 'Working' : 'Ready'}</small>}</span></div>
    <button type="button" className={css.connectorHeading} aria-expanded={showApps} onClick={() => { setAppsOpen(value => !value) }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-5 5v4M7 8v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg><span>Connected apps</span><span aria-hidden="true">{showApps ? '⌄' : '›'}</span></button>
    {showApps && <>
      {error ? <p role="status">Apps could not be loaded. Reopen this page to try again.</p> : accounts === undefined ? <p>Loading connected apps…</p> :
        <div className={css.accounts}>{accounts.length ? accounts.map(account => <a className={css.account} key={account.id} href="/hivemind/app/connectors">
          <img className={css.logo} src={`https://logos.composio.dev/api/${encodeURIComponent(account.toolkit)}`} alt="" /><span className={css.appName}>{names[account.toolkit.toLowerCase()] ?? account.toolkit}<small>Connected</small></span><span aria-hidden="true">›</span>
        </a>) : ['gmail', 'slack', 'googledocs'].map(toolkit => <a className={css.account} key={toolkit} href="/hivemind/app/connectors"><img className={css.logo} src={`https://logos.composio.dev/api/${toolkit}`} alt="" /><span className={css.appName}>{names[toolkit]}</span><span>Connect ›</span></a>)}</div>}
      <a className={css.more} href="/hivemind/app/connectors">Manage apps <span aria-hidden="true">›</span></a>
    </>}
    {hyperagents && <button type="button" className={css.connectorHeading} onClick={() => { setOpen(false); showDetails() }}><span>Agent details</span><span aria-hidden="true">›</span></button>}
    {environmentActivity}
    <SessionCredits sessionId={sessionId} />
  </>
  if (hero) return null
  return <div ref={controlRef} className={css.chatControl} data-mobile-agent-environment={nativeChatRoute && compact || undefined} style={preview.open && !(nativeChatRoute && compact) ? { position: 'fixed', right: preview.inset + 8, top: 64, zIndex: 20 } : undefined}>
    <button className={css.chatButton} type="button" aria-expanded={showPanel} aria-label="HIVEMIND environment" onClick={() => { if (preview.wide && !(nativeChatRoute && compact)) { setOpen(true); setWideOpen(value => !value) } else setOpen(value => !value) }}>{hyperagents && !showPanel && <span className={css.compactIdentity}>{employee ? <EmployeeAvatar employee={employee} size={24} /> : <RuntimeAvatar size={24} />}<strong>{identity?.name ?? 'Runtime'}</strong></span>}{busy && <span className={css.activityDot} aria-label="Background work running" />}<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" /><circle cx="7" cy="5" r="2" fill="white" stroke="currentColor"/><circle cx="13" cy="10" r="2" fill="white" stroke="currentColor"/><circle cx="8" cy="15" r="2" fill="white" stroke="currentColor"/></svg></button>
    {showPanel && nativeChatRoute && compact && <button type="button" className={css.mobileBackdrop} aria-label="Close environment" onClick={() => { setOpen(false) }} /> }
    {showPanel && <section className={css.chatPanel} style={preview.open && !(nativeChatRoute && compact) ? { position: 'fixed', right: preview.inset + 8, top: 108, maxWidth: preview.available } : undefined} role={nativeChatRoute && compact ? 'dialog' : undefined} aria-modal={nativeChatRoute && compact || undefined} aria-label="HIVEMIND connected apps">{content}</section>}
  </div>
}
