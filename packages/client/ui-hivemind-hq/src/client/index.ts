/** Native header contribution over generated, tenant-authorized HQ Remote contracts. */
import { createElement, useEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import hqRemote from '@deepseek-ai/dsh-hivemind-hq-runtime/remote'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { CompanyWorkspace, type CompanyWorkspaceProps } from './CompanyWorkspace.tsx'
import { HqControlAction, type HqControlActionProps, type HqControlInjected } from './HqControlAction.tsx'
import { en, zh, type HqKey } from './locales.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'hivemind.hq': HqKey } }
export const inject = ['sessions', 'remote', 'slots', 'locale']

/**
 * Mount the generated native HQ namespace and its human-only header controls.
 * @param ctx - native browser runtime services.
 * @returns disposer of both scoped UI effects and the Remote namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(hqRemote)
  const ui = ctx.inject(['sessions', 'remote.hivemindHq', 'slots', 'locale'], (child) => {
    child.effect(() => child.locale.register('hivemind.hq', { en, zh }))
    const actions: HqControlInjected = {
      load: sessionId => child.remote.hivemindHq.mode(sessionId),
      setMode: (sessionId, request) => child.remote.hivemindHq.setMode(sessionId, request),
    }
    const ScopedControl = (props: HqControlActionProps) => {
      const [canonical, setCanonical] = useState<SessionId>()
      useEffect(() => {
        let disposed = false
        void runtime.then((result) => {
          if (!disposed && result.ok) setCanonical(result.value.sessionId)
        }, () => {})
        return () => { disposed = true }
      }, [])
      const preset = useSyncExternalStore(listener => child.sessions.list.subscribe(listener),
        () => child.sessions.list.getSnapshot().byId[props.sessionId]?.projectionValues?.agentPreset
          ?? child.sessions.list.getSnapshot().byId[props.sessionId]?.agentPreset)
      return props.sessionId === canonical || preset === 'hivemind-hq' ? createElement(HqControlAction, props) : null
    }
    // Resolve the canonical chat on authenticated admission without waking it.
    const runtime = child.remote.hivemindHq.start()
    void runtime.catch(error => child.logger.warn(`HQ initialization unavailable: ${String(error)}`))
    // HQ admission is independent of optional navigation. Calendar uses the
    // native session and layout services, without requiring directory picking.
    const calendarMount = child.inject(['sessions', 'remote.hivemindHq', 'slots', 'locale', 'layout'], (calendar) => {
      const panel = 'hivemind-company-calendar' as MainPanelId
      const openSession = (id: SessionId) => {
        calendar.sessions.open(id)
        calendar.layout.selectPanel(null)
      }
      const workspace: Omit<CompanyWorkspaceProps, 'sessionId'> = {
        progress: (id, taskId) => calendar.remote.hivemindHq.taskProgress(id, taskId),
        history: (id, wakeId) => calendar.remote.hivemindHq.wakeHistory(id, wakeId),
        load: id => calendar.remote.hivemindHq.workspace(id),
        plan: (id, request) => calendar.remote.hivemindHq.plan(id, request),
        openSession,
        subscribe: (id, callback) => {
          // A burst of native events invalidates one projection, not one Remote
          // read per streamed token. Conversation streaming stays independent.
          let timer: ReturnType<typeof setTimeout> | undefined
          const invalidate = () => { timer ??= setTimeout(() => { timer = undefined; callback() }, 150) }
          const disposeSession = calendar.sessions.binding(id)?.session.subscribe(invalidate)
          const disposeList = calendar.sessions.list.subscribe(invalidate)
          const disposeSchedule = calendar.remote.$on('schedule/changed', invalidate)
          return () => { if (timer) clearTimeout(timer); disposeSession?.(); disposeList(); disposeSchedule() }
        },
      }
      const Workspace = () => {
        const list = useSyncExternalStore(
          listener => calendar.sessions.list.subscribe(listener), () => calendar.sessions.list.getSnapshot())
        const [id, setId] = useState<SessionId>()
        const [error, setError] = useState(false)
        useEffect(() => {
          let disposed = false
          void runtime.then((result) => {
            if (disposed) return
            if (!result.ok) { setError(true); return }
            setId(result.value.sessionId)
          }, () => { if (!disposed) setError(true) })
          return () => { disposed = true }
        }, [])
        // The server chooses the canonical company root, never the newest tab.
        void list
        return id ? createElement('div', { style: { height: '100%', overflow: 'auto' } },
          createElement('button', { onClick: () => openSession(id) }, calendar.locale.bind('hivemind.hq')('openRuntime')),
          createElement(HqControlAction, { ...actions, sessionId: id, t: calendar.locale.bind('hivemind.hq') }),
          createElement(CompanyWorkspace, { ...workspace, sessionId: id }))
          : createElement('p', null, calendar.locale.bind('hivemind.hq')(error ? 'unavailable' : 'starting'))
      }
      const runtimePanel = 'hivemind-runtime-chat' as MainPanelId
      const RuntimeEntry = () => {
        const [failed, setFailed] = useState(false)
        useEffect(() => {
          let disposed = false
          void runtime.then((result) => {
            if (disposed) return
            if (result.ok) openSession(result.value.sessionId)
            else setFailed(true)
          }, () => { if (!disposed) setFailed(true) })
          return () => { disposed = true }
        }, [])
        return createElement('p', null, calendar.locale.bind('hivemind.hq')(failed ? 'unavailable' : 'starting'))
      }
      calendar.slots.inject('main', () => calendar.slots.register({ name: 'main', key: runtimePanel,
        locale: 'hivemind.hq', inject: () => ({}),
      }, RuntimeEntry))
      calendar.slots.inject('sidebar.panellist', () => calendar.slots.register({ name: 'sidebar.panellist', id: runtimePanel,
        order: 10, locale: 'hivemind.hq', label: () => 'Runtime',
      }, () => createElement('span', { 'aria-hidden': true }, '◉')))
      calendar.slots.inject('main', () => calendar.slots.register({ name: 'main', key: panel, locale: 'hivemind.hq', inject: () => ({}) }, Workspace))
      calendar.slots.inject('sidebar.panellist', () => calendar.slots.register({ name: 'sidebar.panellist', id: panel, order: 11,
        locale: 'hivemind.hq', label: () => 'Company calendar',
      }, () => createElement('span', { 'aria-hidden': true }, '▦')))
      calendar.slots.inject('conversation.session.header.actions', () => calendar.slots.register({
        name: 'conversation.session.header.actions', id: 'hivemind.company-calendar', order: 16,
        locale: 'hivemind.hq', inject: () => ({}),
      }, () => createElement('button', { onClick: () => calendar.layout.selectPanel(panel) }, 'Company calendar')))
    })
    child.effect(() => () => calendarMount.dispose())
    child.slots.inject('conversation.session.header.actions', () => child.slots.register({
      name: 'conversation.session.header.actions', id: 'hivemind.hq-mode', order: 15, locale: 'hivemind.hq', inject: () => actions,
    }, ScopedControl))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
