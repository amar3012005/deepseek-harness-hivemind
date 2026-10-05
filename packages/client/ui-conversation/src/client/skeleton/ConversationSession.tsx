/** Strict per-session header/body content inserted into the resident conversation layout. */

import { useEffect } from 'react'
import clsx from 'clsx'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps,
  ConversationSidebarViewTabsSlotProps,
} from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps
export type ConversationSidebarViewTabsProps = ConversationSidebarViewTabsSlotProps

/** Native view selector, reusable without changing the owning session store. */
export function ConversationSidebarViewTabs({ useConversationViews, useStore, selectView }: ConversationSidebarViewTabsProps) {
  const tabs = useConversationViews(value => value)
  const active = resolveActiveView(tabs, useStore(s => s.view))
  if (tabs.length < 2) return null
  return <div className={css.sidebarTabs} role="tablist" aria-label="Conversation view">
    {tabs.map(viewTab => <button
      key={viewTab.id}
      type="button"
      role="tab"
      aria-selected={viewTab.id === active?.id}
      className={clsx(css.sidebarTab, viewTab.id === active?.id && css.sidebarTabActive)}
      onClick={() => { selectView(viewTab.id) }}
    >{viewTab.label}</button>)}
  </div>
}

interface Breadcrumb {
  readonly id: SessionId
  readonly displayTitle: string
  readonly subagent: boolean
}

function deriveAncestry(list: SessionListState, id: SessionId): readonly Breadcrumb[] {
  const chain: Breadcrumb[] = []
  const seen = new Set<SessionId>()
  let cursor: SessionId | undefined = id
  while (cursor !== undefined) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const summary: SessionSummary | undefined = list.byId[cursor]
    if (summary === undefined) break
    chain.unshift({
      id: summary.id,
      displayTitle: summary.displayTitle,
      subagent: summary.origin === 'subagent',
    })
    if (summary.origin !== 'subagent') break
    cursor = summary.parentId
  }
  return chain
}

function equalBreadcrumbs(left: readonly Breadcrumb[], right: readonly Breadcrumb[]): boolean {
  return left.length === right.length
    && left.every((item, index) => {
      const other = right.at(index)
      return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle
    })
}

/**
 * Renders Session header chrome above the resident conversation scrollport.
 * @param props - Strict Session store, view ledger, navigation, render, and locale shares.
 * @returns the hidden blank-session header or visible title and tabs.
 */
export function ConversationSessionHeader({
  sessionId, useSession, useSessions, useConversation, useConversationViews, useStore,
  renderSlot, open, selectView, showViewTabs = true, t,
}: ConversationSessionHeaderProps) {
  const tabs = useConversationViews(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const ancestry = useSessions(s => deriveAncestry(s, sessionId), equalBreadcrumbs)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  // Both embedded modes keep header utilities available on a new session.
  const embeddedRoute = typeof window !== 'undefined'
    && /^\/hivemind\/app\/(?:employee\/harness|overview)(?:\/|$)/u.test(window.location.pathname)
  const dreaming = typeof window !== 'undefined' && (window.location.pathname === '/hivemind/app/overview/dreaming'
    || new URLSearchParams(window.location.search).has('dreamingParent'))
  const hideChrome = !embeddedRoute && session.blank && conversationPhase(session, conversation) === 'blank'

  return (
    <header
      className={clsx(css.header, hideChrome && css.headerHidden)}
      aria-hidden={hideChrome || undefined}
      data-dreaming-header={dreaming || undefined}
      data-hivemind-employee-header={
        embeddedRoute && /^\/hivemind\/app\/employee\/harness(?:\/|$)/u.test(window.location.pathname) || undefined
      }
    >
      {!hideChrome && (
        <>
          <div className={css.titleRow}>
            <div className={css.titleCluster}>
              {dreaming && <section className={css.dreamingIntro} aria-label="About Dreaming">
                <h1>Dreaming</h1>
                <p>While you’re away, agents explore your company’s memories and bring back new discoveries.</p>
              </section>}
              {!dreaming && <nav className={css.crumbs} aria-label={t('session.hierarchy')}>
                {ancestry.map((summary, index) => {
                  const last = index === ancestry.length - 1
                  const title = (
                    <button
                      type="button"
                      className={clsx(
                        css.crumb,
                        summary.subagent && css.crumbSubagent,
                        last && css.crumbCurrent,
                      )}
                      disabled={last}
                      onClick={() => { open(summary.id) }}
                    >
                      {summary.displayTitle}
                    </button>
                  )
                  const lineage = last || summary.subagent
                  const lineageOwner = {
                    lineageSessionId: summary.id,
                    displayTitle: summary.displayTitle,
                    ...last ? {} : { openTitle: () => { open(summary.id) } },
                  }
                  return (
                    <span key={summary.id} className={css.crumbSeg}>
                      {index > 0 && <span className={css.crumbSep}>/</span>}
                      {lineage
                        ? summary.subagent
                          ? renderSlot(
                            'conversation.session.header.lineage',
                            lineageOwner,
                            { fallback: title },
                          )
                          : (
                            <>
                              {title}
                              {renderSlot(
                                'conversation.session.header.lineage',
                                lineageOwner,
                                { fallback: null },
                              )}
                            </>
                          )
                        : title}
                    </span>
                  )
                })}
                {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
              </nav>}
              {!embeddedRoute && <div className={css.headerActions}>
                {renderSlot('conversation.session.header.actions', {})}
              </div>}
            </div>
            <div className={css.headerUtilities}>
              {!embeddedRoute && renderSlot('conversation.session.header.utilities', {})}
            </div>
            <div className={css.headerCorner} data-conversation-header-corner="">
              {embeddedRoute && renderSlot('conversation.session.header.utilities', { environmentActivity: <>
                {renderSlot('conversation.session.header.actions', {}, { only: 'hivemind.hq-mode' })}
                <div style={{ borderTop: '1px solid #8882', marginTop: 12, paddingTop: 10, textAlign: 'left' }}>
                  <small style={{ display: 'block', marginBottom: 6 }}>Activity</small>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 }}>{renderSlot('conversation.session.header.actions', { compactJobs: true }, { only: 'job-list' })}</div>
                </div>
                <details style={{ borderTop: '1px solid #8882', marginTop: 12, paddingTop: 10, textAlign: 'left' }}><summary>More</summary>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 }}><span>Automated tasks</span>{renderSlot('conversation.session.header.utilities', {}, { only: 'schedule-manager' })}</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 }}><span>Calendar</span>{renderSlot('conversation.session.header.utilities', {}, { only: 'hivemind.company-calendar' })}</div>
                  {renderSlot('conversation.session.header.utilities', {}, { only: 'schedule-catalog' })}{renderSlot('conversation.session.header.utilities', {}, { only: 'session-log-download' })}{renderSlot('conversation.session.header.utilities', {}, { only: 'open-in-app' })}</details>
              </> }, { only: 'brain-connections' })}
              {embeddedRoute && renderSlot('conversation.session.header.utilities', {}, { only: 'dreaming-room' })}

              {renderSlot('conversation.session.header.corner', {})}
            </div>
          </div>
          {showViewTabs && tabs.length > 1 && (
            <div className={css.tabs} role="tablist">
              {tabs.map(viewTab => (
                <button
                  key={viewTab.id}
                  type="button"
                  role="tab"
                  aria-selected={viewTab.id === active?.id}
                  className={clsx(css.tab, viewTab.id === active?.id && css.tabActive)}
                  onClick={() => { selectView(viewTab.id) }}
                >
                  {viewTab.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </header>
  )
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession({
  useSession, useConversation, useConversationViews, useInput, inputActions, useStore, actions,
  renderSlot, bindDraftMirror, openView,
}: ConversationSessionProps) {
  const tabs = useConversationViews(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)
  const viewRequest = useStore(s => s.viewRequest ?? null)

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  if (session.blank && conversationPhase(session, conversation) === 'blank') {
    if (session.openState === 'loading') return <div className={css.sessionWaiting} role="status">Loading conversation…</div>
    if (session.openState === 'error' && session.openError !== null) {
      return <div className={css.sessionWaiting} role="alert">Conversation could not be loaded: {session.openError.message}</div>
    }
    return null
  }
  return (
    <div className={css.viewArea}>
      {active !== undefined && renderSlot('conversation.view', {
        viewRequest,
        openView,
        completeViewRequest: actions.completeViewRequest,
      }, { only: active.id })}
    </div>
  )
}
