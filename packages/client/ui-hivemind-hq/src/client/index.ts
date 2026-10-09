import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { RuntimeFullAccess } from './RuntimeFullAccess.tsx'
import { RuntimeNotificationBanner, type RuntimeNotificationBannerProps } from './RuntimeNotificationBanner.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { RuntimeTaskCard } from './RuntimeTaskCard.tsx'
import { RuntimeTour, type RuntimeTourProps } from './RuntimeTour.tsx'
import { employeeTaskCard } from './employee-task-card.ts'
import { FinalRuntimePlanSummary } from './RuntimePlanSummary.tsx'
/** Native header contribution over generated, tenant-authorized HQ Remote contracts. */
import { createElement, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import hqRemote from '@deepseek-ai/dsh-hivemind-hq-runtime/remote'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-schedule/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { CompanyWorkspace, type CompanyWorkspaceProps } from './CompanyWorkspace.tsx'
import { HqControlAction, type HqControlActionProps, type HqControlInjected } from './HqControlAction.tsx'
import { en, zh, type HqKey } from './locales.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'hivemind.hq': HqKey }
  interface SlotMap { 'hivemind.runtime.fullAccess': { kind:'single';scope:'session' }; 'hivemind.runtime.plan': { kind: 'list'; scope: 'session'; owner: { turn: number } } } }
export const inject = ['sessions', 'remote', 'slots', 'locale', 'layout', 'uiWorkspace']

/**
 * Mount the generated native HQ namespace and its human-only header controls.
 * @param ctx - native browser runtime services.
 * @returns disposer of both scoped UI effects and the Remote namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(hqRemote)
  const ui = ctx.inject(['uiConversation', 'sessions', 'remote.hivemindHq', 'remote.agentPresets', 'slots', 'locale', 'layout', 'uiWorkspace'], (child) => {
    const accessLoad = (id: SessionId, request?: { enabled: boolean; expectedRevision: number }) =>
      child.remote.hivemindHq.fullAccess(id, request)
    const accessSubscribe = (id: SessionId, listener: () => void) =>
      child.sessions.binding(id)?.session.projections.faceOf('permissions').subscribe(listener) ?? (() => {})
    child.slots.inject('hivemind.runtime.fullAccess', () => child.slots.register({
      name: 'hivemind.runtime.fullAccess',
      inject: sessionId => ({ sessionId, load: accessLoad, subscribe: accessSubscribe }),
    }, RuntimeFullAccess))
    child.effect(() => child.locale.register('hivemind.hq', { en, zh }))
    child.effect(() => child.uiConversation.events.register(employeeTaskCard))
    child.slots.inject('conversation.chat.node', () => child.slots.register({
      name: 'conversation.chat.node', key: 'hivemind-employee-task',
      children: { 'hivemind.employee.taskAvatar': { kind: 'single', scope: 'session' } },
    }, ({ node, renderSlot }) => createElement(RuntimeTaskCard, {
      task: node.data.task, employeeName: node.data.employeeName,
      avatar: renderSlot('hivemind.employee.taskAvatar', { employeeId: node.data.employeeId, name: node.data.employeeName }),
      ...(node.data.calendar?.startsAt ? { startsAt: node.data.calendar.startsAt } : {}),
      ...(node.data.calendar?.endsAt ? { endsAt: node.data.calendar.endsAt } : {}),
    })))
    const actions: HqControlInjected = {
      subscribeState: (sessionId, listener) => {
        const source = child.sessions.binding(sessionId)?.eventSource
        if (!source) return () => {}
        const revision = () => source.getSnapshot().entries.filter(entry => entry.type === 'event'
          && ['hivemind/hq-mode', 'hivemind/hq-rest-confirmed'].includes(String(entry.event.type)))
          .map(entry => entry.type === 'event' ? entry.event.seq : '').join(':')
        let previous = revision()
        return source.subscribe(() => {
          const current = revision()
          if (current !== previous) { previous = current; listener() }
        })
      },
      startFresh: (sessionId, request) => child.remote.hivemindHq.startFresh(sessionId, request),
      restState: sessionId => child.remote.hivemindHq.restState(sessionId),
      leaveRestNote: (sessionId, request) => child.remote.hivemindHq.leaveRestNote(sessionId, request),
      load: sessionId => child.remote.hivemindHq.mode(sessionId),
      setMode: (sessionId, request) => child.remote.hivemindHq.setMode(sessionId, request),
    }
    const ScopedControl = (props: HqControlActionProps) => {
      const preset = useSyncExternalStore(listener => child.sessions.list.subscribe(listener),
        () => child.sessions.list.getSnapshot().byId[props.sessionId]?.projectionValues?.agentPreset
          ?? child.sessions.list.getSnapshot().byId[props.sessionId]?.agentPreset)
      return preset === 'hivemind-hq' ? createElement(HqControlAction, props) : null
    }
    const ScopedTour = (props: RuntimeTourProps) => {
      const preset = useSyncExternalStore(listener => child.sessions.list.subscribe(listener),
        () => child.sessions.list.getSnapshot().byId[props.sessionId]?.projectionValues?.agentPreset
          ?? child.sessions.list.getSnapshot().byId[props.sessionId]?.agentPreset)
      return preset === 'hivemind-hq' ? createElement(RuntimeTour, props) : null
    }
    child.slots.inject('conversation.input.dock', () => child.slots.register({
      name: 'conversation.input.dock', id: 'runtime-first-entry-tour', order: -20, locale: 'hivemind.hq',
      inject: sessionId => ({
        sessionId,
        load: (id: typeof sessionId) => child.remote.hivemindHq.tourState(id),
        checkpoint: (id: typeof sessionId, request: Parameters<RuntimeTourProps['checkpoint']>[1]) => child.remote.hivemindHq.checkpointTour(id, request),
        wake: (id: typeof sessionId) => child.remote.hivemindHq.wakeFromTour(id),
        resume: (id: typeof sessionId) => child.remote.hivemindHq.resumeFromTour(id),
        subscribe: (id: typeof sessionId, callback: () => void) => {
          const source = child.sessions.binding(id)?.eventSource
          if (!source) return () => {}
          const signature = () => source.getSnapshot().entries.filter(entry => entry.type === 'event'
            && ['hivemind/hq-tour', 'hivemind/hq-awakening-start', 'hivemind/hq-awakening-checkpoint', 'turn/start', 'turn/end', 'agent/inbox/spliced'].includes(String(entry.event.type)))
            .map(entry => entry.type === 'event' ? entry.event.seq : '').join(':')
          let previous = signature()
          let timer: ReturnType<typeof setTimeout> | undefined
          const dispose = source.subscribe(() => {
            const current = signature()
            if (current === previous) return
            previous = current
            timer ??= setTimeout(() => { timer = undefined; callback() }, 150)
          })
          return () => { dispose(); if (timer) clearTimeout(timer) }
        },
      }),
    }, props => createElement(ScopedTour, props)))
    const ScopedNotifications = ({ sessionId, turn, events }: {
      sessionId: SessionId
      turn: TurnLocation
      events: RuntimeNotificationBannerProps['events'] | undefined
    }) => {
      const preset = useSyncExternalStore(listener => child.sessions.list.subscribe(listener),
        () => child.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset
          ?? child.sessions.list.getSnapshot().byId[sessionId]?.agentPreset)
      return preset === 'hivemind-hq' && events
        ? createElement(RuntimeNotificationBanner, { turn: turn.turn, events }) : null
    }
    child.slots.inject('conversation.chat.turnFooter', () => child.slots.register({
      name: 'conversation.chat.turnFooter', id: 'runtime-email-notification',
      inject: sessionId => ({ events: child.sessions.binding(sessionId)?.eventSource }),
    }, ScopedNotifications))
    child.slots.inject('conversation.chat.turnFooter', () => child.slots.register({
      name: 'conversation.chat.turnFooter', id: 'runtime-final-invitation', locale: 'hivemind.hq',
      children: { 'hivemind.runtime.planAvatar': { kind: 'single', scope: 'session' } },
      inject: sessionId => ({
        sessionId, events: child.sessions.binding(sessionId)?.eventSource,
        load: (id: typeof sessionId) => child.remote.hivemindHq.workspace(id),
        cancel: (id: typeof sessionId, request: { taskId: string; expectedRevision: number }) =>
          child.remote.hivemindHq.cancelScheduledTask(id, request),
      }),
    }, ({ events, renderSlot, turn, ...props }) => events ? createElement(FinalRuntimePlanSummary, { ...props, turn, events, renderAvatar: identity => renderSlot('hivemind.runtime.planAvatar', identity) }) : null))
    const panel = 'hivemind-company-calendar' as MainPanelId
    const workspace: Omit<CompanyWorkspaceProps, 'sessionId'> = {
      progress: (id, taskId) => child.remote.hivemindHq.taskProgress(id, taskId),
      history: (id, wakeId) => child.remote.hivemindHq.wakeHistory(id, wakeId),
      load: id => child.remote.hivemindHq.workspace(id),
      plan: (id, request) => child.remote.hivemindHq.plan(id, request),
      openSession: id => child.uiWorkspace.openSession(id),
      subscribe: (id, callback) => {
        // A burst of native events invalidates one projection, not one Remote
        // read per streamed token. Conversation streaming stays independent.
        let timer: ReturnType<typeof setTimeout> | undefined
        const invalidate = () => { timer ??= setTimeout(() => { timer = undefined; callback() }, 150) }
        const disposeSession = child.sessions.binding(id)?.session.subscribe(invalidate)
        const disposeList = child.sessions.list.subscribe(invalidate)
        const disposeSchedule = child.remote.$on('schedule/changed', invalidate)
        return () => { if (timer) clearTimeout(timer); disposeSession?.(); disposeList(); disposeSchedule() }
      },
    }
    const Workspace = () => {
      const [creating, setCreating] = useState(false)
      const [error, setError] = useState<string>()
      const list = useSyncExternalStore(listener => child.sessions.list.subscribe(listener), () => child.sessions.list.getSnapshot())
      const hq = Object.values(list.byId).filter(item => (item.projectionValues?.agentPreset ?? item.agentPreset) === 'hivemind-hq')
      const id = hq.find(item => item.id === list.current)?.id ?? hq[0]?.id
      return id ? createElement('div', { style: { height: '100%', overflow: 'auto' } },
        createElement(HqControlAction, { ...actions, sessionId: id, t: child.locale.bind('hivemind.hq') }),
        createElement(CompanyWorkspace, { ...workspace, sessionId: id }))
        : createElement('section', { 'data-company-calendar': '', style: { padding: 24 } },
          createElement('h1', null, 'Company calendar'),
          createElement('p', null, 'Create an HQ Runtime to plan company work. Autonomous execution starts paused.'),
          createElement('button', { type: 'button', disabled: creating, onClick: () => {
            setCreating(true); setError(undefined)
            void (async () => {
              const id = await child.sessions.create({ hyperagentRoom: 'runtime' })
              child.uiWorkspace.openSession(id)
              child.layout.selectPanel(panel)
            })().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
              .finally(() => setCreating(false))
          } }, creating ? 'Creating…' : 'Create HQ Runtime'),
          error ? createElement('p', { role: 'alert' }, error) : null)
    }
    child.slots.inject('main', () => child.slots.register({ name: 'main', key: panel, locale: 'hivemind.hq', inject: () => ({}) }, Workspace))
    child.slots.inject('sidebar.panellist', () => child.slots.register({ name: 'sidebar.panellist', id: panel, order: 11,
      locale: 'hivemind.hq', label: () => 'Company calendar',
    }, () => createElement('span', { 'aria-hidden': true }, '▦')))
    // Embedded HIVE hides the native global sidebar; keep the calendar reachable
    // from the same top-right utility row in new and active Harness sessions.
    child.slots.inject('conversation.session.header.utilities', () => child.slots.register({
      name: 'conversation.session.header.utilities', id: 'hivemind.company-calendar', order: -25,
      locale: 'hivemind.hq', inject: () => ({}),
    }, () => createElement('button', {
      type: 'button', 'aria-label': 'Company calendar', title: 'Company calendar',
      onClick: () => child.layout.selectPanel(panel),
      style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer' },
    }, createElement('span', { 'aria-hidden': true }, '▦'))))
    child.slots.inject('conversation.session.header.actions', () => child.slots.register({
      name: 'conversation.session.header.actions', id: 'hivemind.hq-mode', order: 15, locale: 'hivemind.hq', inject: () => actions,
    }, ScopedControl))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
