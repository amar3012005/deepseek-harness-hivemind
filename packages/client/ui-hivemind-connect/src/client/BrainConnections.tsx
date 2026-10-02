import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import { SessionCredits } from './SessionCredits.tsx'
import css from './DreamingConnectors.module.css'
import { EmployeeAvatar, projectedEmployee } from './HyperagentEmployee.tsx'
const names: Record<string, string> = { gmail: 'Gmail', slack: 'Slack', googledocs: 'Google Docs', googledrive: 'Google Drive', github: 'GitHub', notion: 'Notion', outlook: 'Outlook' }
export function BrainConnections({ sessionId, useSessions, environmentActivity, showDetails, hero = false }: PropsRuntime<'conversation.session.header.utilities'> & { hero?: boolean; showDetails: () => void }) {
  const preset = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset ?? state.byId[sessionId]?.agentPreset)
  const employee = useSessions(state => projectedEmployee(
    (state.byId[sessionId]?.projectionValues?.hyperagentOwner ?? state.byId[sessionId]?.projectionValues?.hyperagentSelection)))
  const busy = useSessions(state => (state.jobsBySession[sessionId] ?? []).some(job => job.status === 'running' || job.status === 'stopping'))
  const running = useSessions(state => state.byId[sessionId]?.running === true)
  const [open, setOpen] = useState(true)
  const [appsOpen, setAppsOpen] = useState(false)
  const [accounts, setAccounts] = useState<{ id: string; toolkit: string }[]>()
  const [error, setError] = useState(false)
  const dreaming = window.location.pathname.endsWith('/dreaming') || new URLSearchParams(window.location.search).has('dreamingParent')
  const hyperagents = preset === 'hivemind-hyperagents' || preset === 'hyperagents' || preset === 'hyperagents-compressed' || window.location.pathname.startsWith('/hivemind/app/employee/harness')
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
  if ((!brain && !hyperagents) || dreaming) return null
  const content = <>
    <div className={css.environmentHeading}><span className={css.dots} aria-hidden="true"><i /><i /><i /></span><span>Environment</span><button type="button" onClick={() => { setOpen(false) }}>Hide</button></div>
    <div className={css.identity}>{employee ? <EmployeeAvatar employee={employee} size={32} /> : <span className={css.avatar}>H</span>}
      <span><strong>{employee?.name ?? (hyperagents ? 'HyperAgents' : 'HIVEMIND-Chat')}</strong><small>{employee?.role ?? (hyperagents ? 'Your agent workspace' : 'Your company brain')}</small>{hyperagents && <small className={css.agentStatus}><i className={running || busy ? css.workingDot : css.readyDot} aria-hidden="true" />{running || busy ? 'Working' : 'Ready'}</small>}</span></div>
    <button type="button" className={css.connectorHeading} aria-expanded={appsOpen} onClick={() => { setAppsOpen(value => !value) }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-5 5v4M7 8v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg><span>Connect apps</span><span aria-hidden="true">{appsOpen ? '⌄' : '›'}</span></button>
    {appsOpen && <>
      {error ? <p role="status">Apps could not be loaded. Reopen this page to try again.</p> : accounts === undefined ? <p>Loading connected apps…</p> :
        <div className={css.accounts}>{accounts.length ? accounts.map(account => <a className={css.account} key={account.id} href="/hivemind/app/connectors">
          <img className={css.logo} src={`https://logos.composio.dev/api/${encodeURIComponent(account.toolkit)}`} alt="" /><span className={css.appName}>{names[account.toolkit.toLowerCase()] ?? account.toolkit}<small>Connected · {account.id.slice(-6)}</small></span><span aria-hidden="true">›</span>
        </a>) : ['gmail', 'slack', 'googledocs'].map(toolkit => <a className={css.account} key={toolkit} href="/hivemind/app/connectors"><img className={css.logo} src={`https://logos.composio.dev/api/${toolkit}`} alt="" /><span className={css.appName}>{names[toolkit]}</span><span>Connect ›</span></a>)}</div>}
      <a className={css.more} href="/hivemind/app/connectors">More apps <span aria-hidden="true">›</span></a>
    </>}
    {hyperagents && <button type="button" className={css.connectorHeading} onClick={() => { setOpen(false); showDetails() }}><span>Agent details</span><span aria-hidden="true">›</span></button>}
    {environmentActivity}
    <SessionCredits sessionId={sessionId} />
  </>
  if (hero) return null
  return <div className={css.chatControl}>
    <button className={css.chatButton} type="button" aria-expanded={open} aria-label="HIVEMIND environment" onClick={() => { setOpen(value => !value) }}>{busy && <span className={css.activityDot} aria-label="Background work running" />}<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" /><circle cx="7" cy="5" r="2" fill="white" stroke="currentColor"/><circle cx="13" cy="10" r="2" fill="white" stroke="currentColor"/><circle cx="8" cy="15" r="2" fill="white" stroke="currentColor"/></svg></button>
    {open && <section className={css.chatPanel} aria-label="HIVEMIND connected apps">{content}</section>}
  </div>
}
