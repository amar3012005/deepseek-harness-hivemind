import { roomIdentity } from './room-identity.ts'
import { isEnvironmentPreviewOpen } from './environment-preview.ts'
import { websiteRead, type WebsiteRead } from './website-sources.ts'
import { WebsitePreviewUpdates, WebsiteSourceCard } from './WebsitePreview.tsx'
import { decodeArtifactText } from './artifact-text.ts'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { RuntimeAwakening } from './RuntimeAwakening.tsx'
import { scheduledWork, type ScheduledWork } from './scheduled-work.ts'
import { AgentChatAvatar } from './AgentChatAvatar.tsx'
import { RuntimeActivity } from './RuntimeActivity.tsx'
import { BrainConnections } from './BrainConnections.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-schedule/client'
import { DreamingAutomation } from './DreamingAutomation.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { DreamingRoom } from './DreamingRoom.tsx'
import { DreamingSettings } from './DreamingSettings.tsx'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import { en, zh, type HivemindConnectKey } from './locales.ts'
import { setupEmbedMessaging } from './embed.ts'
import { ComposioConnectionCard } from './ComposioConnectionCard.tsx'
import {
  connectionPresentationOf, PendingConnectionAuthorization,
} from './connection-question.ts'
import { setupSingulanceHeadline, RoomHeroMark } from './SingulanceMark.tsx'
import { setupHivemindSessionRouting } from './session-route.ts'
import { setupConnectionCallbackReturn } from './connection-callback.ts'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createElement } from 'react'
import { ScopeSelect, type HivemindReadScope } from './ScopeSelect.tsx'
import { createConnectorMentionSource } from './ConnectorMentions.ts'
import { ContextualFollowUps, selectContextualFollowUps } from './ContextualFollowUps.tsx'
import {
  HyperagentEmployeePicker, HyperagentEmployeePanel, HyperagentPanelToggle,
  type EmployeeOption, selectedEmployee, projectedEmployee, EmployeeAvatar,
} from './HyperagentEmployee.tsx'
import { ArtifactDashboard, ArtifactMedia, type LibraryArtifact, type DashboardSelection } from './ArtifactDashboard.tsx'
import { workbenchSnapshot, HyperagentWorkbench, PdfReceipt, TextReceipt, ReceiptImage } from './HyperagentWorkbench.tsx'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'hivemind-website-source': WebsiteRead; 'hivemind-scheduled-work': ScheduledWork; 'runtime-awakening-stage': { turn: number; seq: number } }
}

const awakeningStage: ConversationNodeDefinition<{ turn: number; seq: number }> = {
  kind: 'runtime-awakening-stage', target: 'chat',
  match: event => String(event.type) === 'hivemind/hq-awakening-checkpoint' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => ({ turn: (match.event.data as { turn: number }).turn, seq: match.event.seq }),
  update: context => context.state,
  buildViewNode: context => context.start === undefined ? null : {
    key: context.key, kind: 'runtime-awakening-stage', id: context.id, target: 'chat',
    anchorSeq: context.start.event.seq, location: context.start.location,
    processDisclosure: 'independent', visibility: 'visible', data: context.state,
  },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'shell.sessionRail.artifacts': { kind: 'single'; scope: 'root' } }
  interface LocaleNamespaceMap { 'hivemind-connect': HivemindConnectKey }
}

const NS = 'hivemind-connect'

/** Browser dependencies for the shell-overlay connection control. */
// Match the generic question plugin's minimum activation boundary. The HIVE row
// precedes it in the Web composition, so this listener must not be delayed by
// optional conversation services or the generic handler will claim the
// connection question first.
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']

export interface ConnectionStatus {
  status: 'connected' | 'connecting' | 'disconnected' | 'unavailable'
  userEmail?: string
}

type QuestionListener = TypertClientEventListener<'user-questions/request'>
type ClientQuestionRequest = Parameters<QuestionListener>[0]
type ClientQuestionNext = Parameters<QuestionListener>[1]
type ClientQuestionAnswer = Awaited<ReturnType<QuestionListener>>

async function answerConnectionQuestion(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientQuestionRequest,
  next: ClientQuestionNext,
  publish: PendingInteractionPublisher<PendingConnectionAuthorization>,
): Promise<ClientQuestionAnswer> {
  const recognized = connectionPresentationOf(request.questions)
  if (recognized === undefined) return next()
  const sessionId = ctx.sessions.scopeOf(owner)
  if (sessionId === undefined) return next()
  const session = ctx.sessions.sessionOf(owner)
  const pending = new PendingConnectionAuthorization(
    sessionId,
    recognized,
    request.signal,
    session === undefined ? undefined : async () => { await session.cancel() },
  )
  const completed = Promise.withResolvers<void>()
  const remove = publish(pending, async () => {
    pending.delegate()
    await completed.promise
  })
  try {
    try {
      return await pending.result
    } catch (error) {
      if (pending.isDelegation(error)) return await next()
      throw error
    }
  } finally {
    remove()
    completed.resolve()
  }
}

/** Register the localized HIVE-MIND connection control above sidebar Settings. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('schedule.manager.external', () => ctx.slots.register({ name: 'schedule.manager.external', id: 'company-dreaming', order: 0 }, DreamingAutomation))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name: 'settings.general.item', id: 'company-dreaming', order: 35 }, DreamingSettings))
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/hivemind/app/employee/harness/')) {
    document.documentElement.dataset.dshHyperagentOs = 'true'
    ctx.effect(() => () => { delete document.documentElement.dataset.dshHyperagentOs }, 'ui-hivemind-connect: OS route layout')
  }
  ctx.effect(setupConnectionCallbackReturn, 'ui-hivemind-connect: connected-app authorization return')
  ctx.effect(setupEmbedMessaging, 'ui-hivemind-connect: embedded authentication')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-hivemind-connect: dictionaries')
  const publishConnection = ctx.uiSession.registerPendingInteraction<PendingConnectionAuthorization>(() => 2)
  ctx.remote.$on('user-questions/request', function (request, next) {
    return answerConnectionQuestion(ctx, this, request, next, publishConnection)
  })
  ctx.effect(() => {
    let disposed = false
    const sent = new Map<SessionId, string>()
    const localeFace = ctx.locale as unknown as {
      getSnapshot?: () => { active?: unknown }
      subscribe?: (listener: () => void) => () => void
    }
    const normalize = (value: unknown): string => {
      const match = typeof value === 'string' ? value.toLowerCase().match(/^[a-z]{2}/u) : null
      return match?.[0] ?? 'en'
    }
    const readLanguage = (): string => normalize(
      document.documentElement.dataset.hivemindReplyLanguage ?? document.documentElement.lang ?? localeFace.getSnapshot?.().active,
    )
    let selected = readLanguage()
    const sync = (): void => {
      if (disposed) return
      const sessionId = ctx.sessions.list.getSnapshot().current
      if (sessionId === undefined || sent.get(sessionId) === selected) return
      if (typeof ctx.sessions.scope !== 'function' || typeof ctx.sessions.sessionOf !== 'function') return
      const scope = ctx.sessions.scope(sessionId)
      const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
      if (session === undefined) return
      sent.set(sessionId, selected)
      void session.command(`/hivemind-language ${selected}`).catch(() => { sent.delete(sessionId) })
    }
    const onLanguage = (): void => {
      selected = readLanguage()
      sync()
    }
    const stop = ctx.sessions.list.subscribe(sync)
    const stopLanguage = localeFace.subscribe?.(onLanguage) ?? (() => {})
    window.addEventListener('hivemind:ui-language', onLanguage)
    const languageObserver = new MutationObserver(onLanguage)
    languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-hivemind-reply-language'] })
    sync()
    return () => {
      disposed = true
      stop()
      stopLanguage()
      window.removeEventListener('hivemind:ui-language', onLanguage)
      languageObserver.disconnect()
    }
  }, 'ui-hivemind-connect: navbar reply language')
  // Language synchronization is durable session state, not user-authored chat.
  // Keep its command lifecycle available to replay while omitting the internal
  // transport row from the HIVE-MIND transcript.
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    key: 'hivemind-language',
  }, () => null))
  ctx.inject(['uiConversation'], (scope: ClientContext) => {
    scope.effect(() => scope.uiConversation.events.register(awakeningStage))
    scope.effect(() => scope.uiConversation.events.register(scheduledWork))
    scope.effect(() => scope.uiConversation.events.register(websiteRead))
    scope.effect(
      () => scope.uiConversation.configureWorkspaceRequirement(false),
      'ui-hivemind-connect: filesystem-free conversation',
    )
    scope.effect(
      () => scope.uiConversation.configureSidebarViewNavigation(true),
      'ui-hivemind-connect: session-rail view navigation',
    )
  })
  const renderScopeSelect = (sessionId: SessionId, locked: boolean) => {
    const key = `hivemind:read-scope:${sessionId}`
    let initialScope: HivemindReadScope = 'full'
    let initialProject: string | undefined
    try {
      const stored = sessionStorage.getItem(key)
      if (stored === 'personal' || stored === 'organization' || stored === 'project' || stored === 'full') {
        initialScope = stored
      } else if (stored !== null) {
        const state = JSON.parse(stored) as { scope?: unknown; project?: unknown }
        if (state.scope === 'personal' || state.scope === 'organization' || state.scope === 'project' || state.scope === 'full') {
          initialScope = state.scope
          if (state.scope === 'project' && typeof state.project === 'string' && state.project !== '') initialProject = state.project
        }
      }
    } catch { /* storage can be unavailable in embedded contexts; full is safe */ }
    const onSelect = (id: SessionId, readScope: HivemindReadScope, project?: string): void => {
      try {
        sessionStorage.setItem(key, JSON.stringify({
          scope: readScope,
          ...(project === undefined ? {} : { project }),
        }))
      } catch { /* durable session event remains authoritative */ }
      const scoped = ctx.sessions.scope(id)
      const session = scoped === undefined ? undefined : ctx.sessions.sessionOf(scoped)
      if (session === undefined) return
      const argument = project === undefined ? readScope : `${readScope} ${project}`
      void session.command(`/hivemind-scope ${argument}`)
    }
    return createElement(ScopeSelect, {
      sessionId, locked, initialScope, onSelect,
      ...(initialProject === undefined ? {} : { initialProject }),
    })
  }
  // The native Hero owns scope placement. This deliberately leaves the
  // composer permission, attachment, microphone, and send controls untouched.
  ctx.slots.inject('conversation.hero.scope', () => ctx.slots.register({
    name: 'conversation.hero.scope',
    locale: NS,
  }, ({ sessionId, locked }: { sessionId?: SessionId | undefined; locked: boolean }) => {
    return sessionId === undefined ? null : renderScopeSelect(sessionId, locked)
  }))
  ctx.slots.inject('shell.sessionRail.avatar', () => ctx.slots.register({ name: 'shell.sessionRail.avatar' }, (employee: EmployeeOption) => createElement(EmployeeAvatar, { employee, size: 24 })))
  const employeeTab = '@deepseek-ai/dsh-client-ui-hivemind-connect/employee'
  const workbenchKinds = ['preview', 'artifacts', 'computer', 'sources'] as const
  let rightSidebar: ClientContext['sidebarRight'] | undefined
  const employeeEvents = (sessionId: SessionId) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error('HIVE-MIND employee selection requires an open session')
    return binding.eventSource
  }
  const listEmployees = async (): Promise<EmployeeOption[]> => {
    const response = await fetch('/api/hivemind/employees', { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`employee catalog unavailable (${response.status})`)
    const body = await response.json() as { profiles?: Array<Record<string, unknown>> }
    if (!Array.isArray(body.profiles)) throw new Error('invalid employee catalog')
    return body.profiles.flatMap((profile) => {
      if (typeof profile.id !== 'string' || typeof profile.name !== 'string') return []
      const role = typeof profile.role_archetype === 'string' ? profile.role_archetype : 'employee'
      const avatarUrl = typeof profile.avatar_url === 'string' ? profile.avatar_url : undefined
      return [{ id: profile.id, name: profile.name, role, ...(typeof profile.persona === 'string' ? { persona: profile.persona } : {}), ...(Array.isArray(profile.tools) && profile.tools.every(tool => typeof tool === 'string') ? { allowedTools: profile.tools.filter((tool): tool is string => typeof tool === 'string') } : {}), ...(typeof profile.created_at === 'string' ? { createdAt: profile.created_at } : {}), ...(avatarUrl === undefined ? {} : { avatarUrl }) }]
    })
  }
  let chatDirectory: Promise<EmployeeOption[]> | undefined
  const chatEmployees = () => chatDirectory ??= listEmployees().catch((error) => { chatDirectory = undefined; throw error })
  const chatIdentity = (sessionId: SessionId) => ({
    subscribe: (listener: () => void) => ctx.sessions.list.subscribe(listener),
    getSnapshot: () => {
      const values = ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues
      return values?.hyperagentOwner ?? values?.hyperagentSelection
    },
  })
  ctx.slots.inject('schedule.task.avatar', () => ctx.slots.register({ name: 'schedule.task.avatar' }, ({ targetSessionId, employeeId }) => {
    if (!window.location.pathname.includes('/employee/harness')) return null
    if (employeeId !== undefined) return createElement(AgentChatAvatar, { employeeId, load: chatEmployees })
    const binding = ctx.sessions.binding(targetSessionId)
    return binding === undefined ? null : createElement(AgentChatAvatar, {
      events: binding.eventSource, identity: chatIdentity(targetSessionId), load: chatEmployees,
    })
  }))
  for (const name of ['conversation.chat.assistantAvatar', 'conversation.chat.contextAvatar', 'hivemind.runtime.planAvatar', 'hivemind.employee.taskAvatar'] as const) ctx.slots.inject(name, () => ctx.slots.register({
    name,
  }, ({ employeeId, name: senderName, sessionId }) => window.location.pathname.includes('/employee/harness')
    ? createElement(AgentChatAvatar, {
      ...(employeeId === undefined ? {} : { employeeId }),
      ...(senderName === undefined ? {} : { name: senderName }),
      events: employeeEvents(sessionId), identity: chatIdentity(sessionId), load: chatEmployees,
    }) : null))
  ctx.inject(['remote.commands', 'remote.agentPresets'], (ctx: ClientContext) => {
    const selectEmployee = async (sessionId: SessionId, id: string | null, runtime = false): Promise<boolean> => {
      if (ctx.sessions.binding(sessionId) === undefined) throw new Error('Session is not ready. Please reopen it.')
      const targetPreset = runtime ? 'hivemind-hq' : id === null ? 'hivemind-chat' : 'hivemind-hyperagents'
      const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
      if ((summary?.projectionValues?.agentPreset ?? summary?.agentPreset) !== targetPreset) {
        const switched = await ctx.remote.agentPresets.select(sessionId, targetPreset)
        if (!switched.ok) return false
      }
      if (runtime) {
        window.dispatchEvent(new CustomEvent('hivemind:agent-selected', { detail: { id: 'runtime' } }))
        return true
      }
      // Composition commit precedes asynchronous plugin activation. Read the
      // native command catalog until the existing selection command is ready;
      // never replay the state-changing selection command speculatively.
      let commandReady = false
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const catalog = await ctx.remote.commands.list(sessionId).catch(() => null)
        if (catalog?.ok && catalog.value.some(command => command.name === 'hivemind-employee')) {
          commandReady = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!commandReady) throw new Error('Agent selection is still loading. Please try again.')
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return false
      const events = binding.eventSource
      const before = Math.max(0, ...events.getSnapshot().entries.map(entry => entry.event.seq))
      let cancelWait = () => {}
      const accepted = new Promise<boolean>((resolve) => {
        let settled = false
        let stop = () => {}
        const finish = (value: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          stop()
          resolve(value)
        }
        const timer = setTimeout(() => { finish(false) }, 5000)
        cancelWait = () => { finish(false) }
        const check = () => {
          const snapshot = events.getSnapshot()
          for (const entry of snapshot.entries) {
            if (entry.event.seq <= before) continue
            if (entry.type !== 'event' || (entry.event.type as string) !== 'hivemind/employee-selection') continue
            if ((entry.event.data as { id: string | null }).id !== id) continue
            finish(true)
            return
          }
        }
        stop = events.subscribe(check)
        check()
      })
      const result = await binding.session.command(`/hivemind-employee ${id ?? 'auto'}`).catch(() => null)
      if (result === null || !result.ok || !result.value.matched) { cancelWait(); throw new Error(result !== null && !result.ok ? `Agent selection could not be admitted (${result.error.code}).` : 'Agent selection command is not available.') }
      const ok = await accepted
      if (ok) window.dispatchEvent(new CustomEvent('hivemind:agent-selected', { detail: { id } }))
      return ok
    }
    ctx.effect(() => {
      const bridge = async (id: string | null): Promise<boolean> => {
        const current = ctx.sessions.list.getSnapshot().current
        return current === undefined ? false : id === null ? selectEmployee(current, id) : start(id)
      }
      let pendingRoom: Promise<boolean> | undefined
      const start = (id: string): Promise<boolean> => {
        const next = (pendingRoom ?? Promise.resolve(true)).catch(() => false).then(() => openRoom(id))
        pendingRoom = next
        return next
      }
      const openRoom = async (id: string): Promise<boolean> => {
        document.documentElement.dataset.agentRoomOpening = 'true'
        try {
          const sessionId = await ctx.sessions.create({ hyperagentRoom: id === 'runtime' ? 'runtime' : id })
          window.history.replaceState(window.history.state, '', `/hivemind/app/employee/harness/session/${encodeURIComponent(sessionId)}`)
          window.dispatchEvent(new PopStateEvent('popstate'))
          ctx.sessions.open(sessionId)
          const session = ctx.sessions.binding(sessionId)?.session
          if (session === undefined) return false
          await new Promise<void>((resolve, reject) => {
            let stop = () => {}
            const timer = setTimeout(() => { stop(); reject(new Error('The new session is still opening. Please try again.')) }, 10000)
            const check = () => {
              if (session.getSnapshot().openState !== 'open') return
              clearTimeout(timer); stop(); resolve()
            }
            stop = session.subscribe(check)
            check()
          })
          const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
          const roomOwner = projectedEmployee(summary?.projectionValues?.hyperagentOwner)
          const history = ctx.sessions.binding(sessionId)?.eventSource.getSnapshot()
          const alreadyUsed = summary?.blank === false || history?.entries.some(entry =>
            entry.type === 'event' && ['turn/start', 'hivemind/session-owner'].includes(entry.event.type as string)) === true
          // Authenticated room lookup already selected this employee's room.
          // A restored persistent owner must never be assigned again.
          const selected = id === 'runtime'
            ? await selectEmployee(sessionId, null, true)
            : alreadyUsed || roomOwner?.id === id || await selectEmployee(sessionId, id)
          if (selected) {
            if (id === 'runtime' && !alreadyUsed) {
              const actx = ctx.sessions.scope(sessionId)
              const conversation = ctx.get('conversation')
              if (actx !== undefined && conversation !== undefined) {
                const input = conversation.input.for(actx)
                if (!input.state.getSnapshot().draft.trim()) input.setDraft('Wakeup ! chief')
              }
            }
            // Team navigation opens an agent workspace even while its first
            // draft is blank. Do not wait for a user turn to choose the route.
            window.history.replaceState(window.history.state, '', `/hivemind/app/employee/harness/session/${encodeURIComponent(sessionId)}`)
            window.dispatchEvent(new PopStateEvent('popstate'))
          }
          return selected
        } catch (error) {
          console.warn('HIVEMIND employee room could not open', error instanceof Error ? error.message : 'Room admission failed')
          throw error
        } finally { delete document.documentElement.dataset.agentRoomOpening }
      }
      let scheduledRooms = new Set<string>()
      let scheduleRead = 0
      let disposed = false
      const publish = () => {
        const state = ctx.sessions.list.getSnapshot()
        const current = state.current
        const row = current === undefined ? undefined : state.byId[current]
        const owner = projectedEmployee((row?.projectionValues?.hyperagentOwner ?? row?.projectionValues?.hyperagentSelection))
        const events = current === undefined ? undefined : ctx.sessions.binding(current)?.eventSource.getSnapshot()
        const selection = events === undefined ? null : selectedEmployee(events)
        window.dispatchEvent(new CustomEvent('hivemind:agent-selected', { detail: { id: owner?.id ?? selection?.id ?? null } }))
        const rooms = state.ids.flatMap((id) => {
          const row = state.byId[id]
          if (!row || row.origin === 'subagent' || !['hivemind-hyperagents', 'hivemind-hq'].includes(row.projectionValues?.agentPreset ?? row.agentPreset ?? '')) return []
          const employee = projectedEmployee((row.projectionValues?.hyperagentOwner ?? row.projectionValues?.hyperagentSelection))
          const message = (row.projectionValues as { hyperagentLatestMessage?: string | null } | undefined)?.hyperagentLatestMessage
          let preview = ''
          try { preview = message ? (JSON.parse(message) as { text: string }).text : '' } catch { /* Missing legacy projection. */ }
          return [{ id: employee?.id ?? 'runtime', sessionId: id, preview, running: row.running, unread: row.completed === true, actionRequired: String(ctx.uiSession.pendingInteractions.getSnapshot().get(id)?.kind) === 'approval', scheduled: scheduledRooms.has(id), updatedAt: row.updatedAt }]
        })
        ;(window as unknown as { __HIVEMIND_AGENT_ROOMS__: unknown }).__HIVEMIND_AGENT_ROOMS__ = rooms
        window.dispatchEvent(new CustomEvent('hivemind:agent-rooms', { detail: { rooms } }))
      }
      const refreshSchedules = async (): Promise<void> => {
        const request = ++scheduleRead
        try {
          const result = await ctx.remote.schedule.catalog()
          if (disposed || request !== scheduleRead) return
          scheduledRooms = new Set(result.ok ? result.value.filter(task => task.status === 'active').map(task => task.sessionId) : [])
        } catch {
          if (disposed || request !== scheduleRead) return
          scheduledRooms = new Set()
        }
        publish()
      }
      const stopApproval = ctx.uiSession.pendingInteractions.subscribe(publish)
      const stopSchedule = ctx.remote.$on('schedule/changed', () => { void refreshSchedules() })
      const stopReset = ctx.on('connection/reset', () => { scheduledRooms = new Set(); publish(); void refreshSchedules() })
      void refreshSchedules()
      const stop = ctx.sessions.list.subscribe(publish)
      window.addEventListener('hivemind:request-agent-rooms', publish)
      publish()
      const host = window as unknown as { __HIVEMIND_SELECT_AGENT__?: typeof bridge; __HIVEMIND_START_AGENT__?: typeof start }
      host.__HIVEMIND_SELECT_AGENT__ = bridge
      host.__HIVEMIND_START_AGENT__ = start
      return () => {
        disposed = true
        stopApproval()
        stopSchedule()
        stopReset()
        stop()
        window.removeEventListener('hivemind:request-agent-rooms', publish)
        if (host.__HIVEMIND_SELECT_AGENT__ === bridge) delete host.__HIVEMIND_SELECT_AGENT__
        if (host.__HIVEMIND_START_AGENT__ === start) delete host.__HIVEMIND_START_AGENT__
      }
    }, 'ui-hivemind-connect: unified composer agent selection')
    ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left', id: 'hivemind-employee-picker', order: 20, locale: NS,
      inject: (sessionId): {
        hooks: { employeeEvents: ReturnType<typeof employeeEvents> }
        listEmployees: typeof listEmployees
        selectEmployee: (id: string | null) => Promise<boolean>
      } => ({
        hooks: { employeeEvents: employeeEvents(sessionId) },
        listEmployees,
        selectEmployee: (id) => {
          const host = window as unknown as { __HIVEMIND_START_AGENT__?: (id: string) => Promise<boolean> }
          return id === null ? selectEmployee(sessionId, null) : host.__HIVEMIND_START_AGENT__?.(id) ?? Promise.resolve(false)
        },
      }),
    }, HyperagentEmployeePicker))
  })
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'brain-connections', locale: NS, order: 99,
    inject: sessionId => ({ sessionId, isPreviewOpen: () => isEnvironmentPreviewOpen(rightSidebar), showDetails: () => { rightSidebar?.openTabIn(sessionId, 'hivemind-employee') } }),
  }, BrainConnections))
  // Put the panel/preview affordance in the conversation header's far-right
  // corner, matching the native “door” control. A higher-priority seat shadows
  // ui-sidebar-right's generic expand button; this implementation preserves
  // its expand/collapse behavior for non-HyperAgents sessions.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'dreaming-room', locale: NS, order: 100,
    inject: sessionId => ({ sessionId }),
  }, DreamingRoom))
  ctx.slots.inject('conversation.session.header.corner', () => ctx.slots.register({
    name: 'conversation.session.header.corner', locale: NS, priority: -1,
    inject: sessionId => ({ hooks: { employeeEvents: employeeEvents(sessionId) }, closePreview: () => {
      if (rightSidebar === undefined) return false
      try {
        if (rightSidebar.isExpanded()) rightSidebar.toggleExpanded()
        return true
      } catch (error) {
        if (error instanceof Error && error.message === 'sidebarRight: no session surface is mounted') return false
        throw error
      }
    }, swapPanel: (hyperagents) => {
      const sidebar = rightSidebar
      if (sidebar === undefined) return
      if (sidebar.isExpanded()) { sidebar.toggleExpanded(); return }
      if (hyperagents) sidebar.openTab('hivemind-workbench-preview')
      else sidebar.toggleExpanded()
    } }),
  }, HyperagentPanelToggle))
  // Preview and download read session attachments, and thumbnail rendering
  // uses the conversation image cache. Inject both services in the pane scope;
  // the header toggle is registered above and remains independent of it.
  ctx.inject(['sidebarRight', 'sidebarRightTabs', 'remote.session', 'remote.schedule', 'uiConversation', 'layout'], (scope: ClientContext) => {
    rightSidebar = scope.sidebarRight
    const artifactsPanel = 'hivemind-artifacts' as import('@deepseek-ai/dsh-client-ui-layout/client').MainPanelId
    const dashboardSelection: DashboardSelection = { category: 'All' }
    const dashboardInjected = (page = false) => ({
      page, selection: dashboardSelection,
      expand: () => { scope.layout.selectPanel(artifactsPanel) },
      collapse: () => { scope.layout.selectPanel(null) },
      load: async (signal: AbortSignal) => {
        const rooms = Object.values(scope.sessions.list.getSnapshot().byId).filter(room =>
          ['hivemind-hyperagents', 'hivemind-hq', 'hyperagents', 'hyperagents-compressed'].includes(String(room.agentPreset ?? room.projectionValues?.agentPreset)))
        const artifacts: LibraryArtifact[] = []
        let incomplete = rooms.length > 100
        let readBudget = 200
        // Read cold-safe persisted pages sequentially; no room activation or work dispatch.
        for (const room of rooms.slice(0, 100)) {
          signal.throwIfAborted()
          if (readBudget === 0) { incomplete = true; break }
          const id = room.id
          let beforeSeq: number | undefined
          let throughSeq: number | undefined
          for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
            if (readBudget-- === 0) { incomplete = true; readBudget = 0; break }
            const response = await scope.remote.session.page({ address: { kind: 'session', sessionId: id }, maxMessages: 100,
              ...(throughSeq === undefined ? {} : { throughSeq }), ...(beforeSeq === undefined ? {} : { beforeSeq }) }, signal)
            if (!response.ok) { incomplete = true; break }
            const page = response.value
            throughSeq = page.cursor
            const entries = page.records as unknown as import('@deepseek-ai/dsh-api-session-controller/client').SessionEventWindow['entries']
            const found = workbenchSnapshot({ entries, hasMore: page.hasMore, revision: 0, change: { kind: 'replace', entries } }).artifacts
            artifacts.push(...found.map(artifact => ({ ...artifact, sessionId: id, roomTitle: room.title || 'Agent room' })))
            if (!page.hasMore) break
            beforeSeq = page.records[0]?.event.seq
            if (beforeSeq === undefined || throughSeq === undefined || pageNumber === 9) { incomplete = true; break }
          }
        }
        return { artifacts: artifacts.filter((item, index, all) => all.findIndex(other => other.id === item.id) === index), incomplete }
      },
      loadImage: (sessionId: SessionId, ref: ImageAttachmentRef) => scope.uiConversation.imageUrl(sessionId, ref),
      renderArtifact: (artifact: LibraryArtifact) => {
        const loadBlob = async (file: FileAttachmentRef) => {
          const response = await scope.remote.session.fileAttachment({ sessionId: artifact.sessionId, attachmentId: file.attachmentId })
          if (!response.ok || response.value.attachment.attachmentId !== file.attachmentId) throw new Error('Artifact unavailable')
          const data = atob(response.value.data)
          if (data.length !== file.bytes || data.length > 64 * 1024 * 1024) throw new Error('Artifact size mismatch')
          return new Blob([Uint8Array.from(data, char => char.charCodeAt(0))], { type: artifact.mediaType })
        }
        const loadImage = (ref: ImageAttachmentRef) => scope.uiConversation.imageUrl(artifact.sessionId, ref)
        if (artifact.file && artifact.mediaType === 'application/pdf') return createElement(PdfReceipt, { artifact, loadPdf: loadBlob, loadImage, t: scope.locale.bind(NS) })
        if (artifact.file && (artifact.mediaType.startsWith('text/') || /\.(md|markdown|txt|html?)$/i.test(artifact.path))) return createElement(TextReceipt, {
          file: artifact.file, mediaType: artifact.mediaType, t: scope.locale.bind(NS), loadText: async file => decodeArtifactText(file,
            await scope.remote.session.fileAttachment({ sessionId: artifact.sessionId, attachmentId: file.attachmentId })),
        })
        if (artifact.file && (artifact.mediaType.startsWith('video/') || artifact.mediaType.startsWith('image/'))) return createElement(ArtifactMedia, { artifact, loadBlob })
        return createElement(ReceiptImage, { attachment: artifact.preview, loadImage })
      },
    })
    scope.slots.inject('conversation.input.left', () => scope.slots.register({ name: 'conversation.input.left', id: 'host-artifacts', inject: () => ({ ...dashboardInjected(), hostSeat: true }) }, ArtifactDashboard))
    scope.slots.inject('shell.sessionRail.artifacts', () => scope.slots.register({ name: 'shell.sessionRail.artifacts', inject: () => dashboardInjected() }, ArtifactDashboard))
    scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: artifactsPanel, inject: () => dashboardInjected(true) }, ArtifactDashboard))
    scope.effect(() => () => { rightSidebar = undefined }, 'ui-hivemind-connect: release right sidebar')
    const t = scope.locale.bind(NS)
    scope.effect(() => scope.sidebarRightTabs.register({ id: employeeTab, kind: 'hivemind-employee', title: () => 'Agent details' }), 'ui-hivemind-connect: employee right tab')
    for (const kind of workbenchKinds) {
      const tabKind = `hivemind-workbench-${kind}`
      const tabId = `@deepseek-ai/dsh-client-ui-hivemind-connect/${kind}`
      scope.effect(() => scope.sidebarRightTabs.register({ id: tabId, kind: tabKind, title: () => t(`workbench.${kind}`) }), `ui-hivemind-connect: ${kind} tab`)
      scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
        name: 'sidebar.right.pane.tab', key: tabId, locale: NS,
        inject: sessionId => ({
          kind,
          selectArtifact: (artifactId: string) => { scope.sidebarRight.openTabIn(sessionId, 'hivemind-workbench-preview', { params: { artifactId } }) },
          openWorkbench: (nextKind: typeof kind) => { scope.sidebarRight.openTab(`hivemind-workbench-${nextKind}`) },
          hooks: { employeeEvents: employeeEvents(sessionId) },
          loadImage: (ref: ImageAttachmentRef) => scope.uiConversation.imageUrl(sessionId, ref),
          loadText: async (file: FileAttachmentRef) => decodeArtifactText(file,
            await scope.remote.session.fileAttachment({ sessionId, attachmentId: file.attachmentId })),
          loadPdf: async (file: FileAttachmentRef) => {
            const result = await scope.remote.session.fileAttachment({ sessionId, attachmentId: file.attachmentId })
            if (!result.ok || result.value.attachment.attachmentId !== file.attachmentId) throw new Error('Artifact preview unavailable')
            const binary = atob(result.value.data)
            if (binary.length !== file.bytes || binary.length > 64 * 1024 * 1024) throw new Error('Artifact size mismatch')
            if (!binary.startsWith('%PDF-')) throw new Error('Artifact is not a PDF')
            const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
            return new Blob([bytes], { type: 'application/pdf' })
          },
          openArtifact: (artifact: { mediaType: string; file: FileAttachmentRef | undefined }, disposition: 'open' | 'download' = 'open') => {
            const file = artifact.file
            if (file === undefined) return
            const opened = disposition === 'open' && artifact.mediaType === 'application/pdf' ? window.open('about:blank', '_blank') : null
            void scope.remote.session.fileAttachment({ sessionId, attachmentId: file.attachmentId }).then((result) => {
              if (!result.ok || result.value.attachment.attachmentId !== file.attachmentId) throw new Error('Artifact download failed')
              const binary = atob(result.value.data)
              if (binary.length !== file.bytes || binary.length > 64 * 1024 * 1024) throw new Error('Artifact size mismatch')
              const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
              const url = URL.createObjectURL(new Blob([bytes], { type: artifact.mediaType }))
              if (opened !== null) opened.location.href = url
              else {
                const link = document.createElement('a')
                link.href = url
                link.download = file.name
                link.click()
              }
              setTimeout(() => { URL.revokeObjectURL(url) }, 60_000)
            }).catch(() => { opened?.close() })
          },
        }),
      }, HyperagentWorkbench))
    }
    {
      scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
        name: 'sidebar.right.pane.tab', key: employeeTab, locale: NS,
        inject: sessionId => ({
          hooks: { employeeEvents: employeeEvents(sessionId) },
          openSession: (id: string) => { scope.sessions.open(id as SessionId) },
          selectArtifact: (artifactId: string) => { scope.sidebarRight.openTabIn(sessionId, 'hivemind-workbench-preview', { params: { artifactId } }) },
          listEmployees,
          listRoutines: async () => {
            const result = await scope.remote.schedule.catalog()
            if (!result.ok) throw new Error('Routine list unavailable')
            return result.value.filter(task => task.sessionId === sessionId).map(task => ({
              id: task.id, title: task.title, kind: task.kind, active: task.status === 'active', next: task.scheduledAt,
              toggle: async (enabled: boolean) => {
                const { sessionId: ownerId, status: _status, lastDelivery: _delivery, ...expected } = task
                const changed = await scope.remote.schedule.update({ sessionId: ownerId, id: task.id, expected, enabled })
                if (!changed.ok || !('updated' in changed.value) || !changed.value.updated) throw new Error('Routine update rejected')
              },
            }))
          },
        }),
      }, HyperagentEmployeePanel))
    }
  })
  ctx.inject(['conversation'], () => {
    const sendFollowUp = (prompt: string): void => {
      const sessionId = ctx.sessions.list.getSnapshot().current
      const scope = sessionId === undefined ? undefined : ctx.sessions.scope(sessionId)
      const conversation = scope?.get('conversation')
      if (conversation !== undefined) void conversation.send(prompt)
    }
    ctx.slots.inject('conversation.chat.workUpdates', () => ctx.slots.register({
      name: 'conversation.chat.workUpdates', id: 'hivemind-current-activity', locale: NS,
    }, ({ turn, sessionId, t }) => window.location.pathname.includes('/employee/harness')
      ? createElement(RuntimeActivity, { turn, events: employeeEvents(sessionId), t }) : null))
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node', key: 'hivemind-website-source', locale: NS,
      inject: sessionId => ({ open: (sourceUrl: string) => { rightSidebar?.openTabIn(sessionId, 'hivemind-workbench-preview', { params: { sourceUrl } }) } }),
    }, ({ node, open, t }) => createElement(WebsiteSourceCard, { sources: node.data.sources, open, t })))
    ctx.slots.inject('conversation.chat.workUpdates', () => ctx.slots.register({
      name: 'conversation.chat.workUpdates', id: 'hivemind-source-preview-updates',
      inject: sessionId => ({ events: employeeEvents(sessionId), open: (sourceUrl: string) => {
        rightSidebar?.openTabIn(sessionId, 'hivemind-workbench-preview', { params: { sourceUrl } })
      } }),
    }, WebsitePreviewUpdates))
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node', key: 'hivemind-scheduled-work',
      children: { 'schedule.confirmed.tasks': { kind: 'single', scope: 'session' } },
    }, ({ node, renderSlot }) => renderSlot('schedule.confirmed.tasks', { ids: node.data.ids, ...(node.data.employeeIds === undefined ? {} : { employeeIds: node.data.employeeIds }) })))
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node', key: 'runtime-awakening-stage',
      children: { 'hivemind.runtime.plan': { kind: 'list', scope: 'session' } },
      inject: sessionId => ({ events: employeeEvents(sessionId), openArtifact: (artifactId: string) => {
        rightSidebar?.openTabIn(sessionId, 'hivemind-workbench-preview', { params: { artifactId } })
      } }),
    }, ({ node, events, renderSlot, openArtifact }) => createElement(RuntimeAwakening, {
      turn: node.data.turn, checkpointSeq: node.data.seq, events, renderSlot, openArtifact,
    })))
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail', priority: 40,
      select: selectContextualFollowUps,
    }, ({ matched }) => createElement(ContextualFollowUps, { matched, send: sendFollowUp })))
  })
  // Draft-only actions use the native plus menu and per-session input facade.
  // No task, schedule, or generation starts until the user submits the draft.
  const composerActions = [
    { name: 'Create image', token: 'create-image', detail: 'Describe the image you want to create' },
    { name: 'Schedule task', token: 'schedule-task', detail: 'Describe the task and when it should run' },
    { name: 'Create PDF', token: 'create-pdf', detail: 'Describe the PDF you want to create' },
    { name: 'Create document', token: 'create-document', detail: 'Describe the document you want to create' },
  ] as const
  ctx.inject(['inputTriggers', 'conversation'], (scope: ClientContext) => {
    const inputTriggers = scope.get('inputTriggers') as {
      registerSource(source: Omit<ReturnType<typeof createConnectorMentionSource>, 'onPick'> & {
        lexicon?: () => readonly string[]
        showGroupTitle?: boolean
        onPick(input: { candidate: Parameters<ReturnType<typeof createConnectorMentionSource>['onPick']>[0]['candidate']; session: { sessionId: SessionId } }): ReturnType<ReturnType<typeof createConnectorMentionSource>['onPick']> | 'handled'
      }): () => void
    } | undefined
    if (inputTriggers === undefined) return
    ctx.effect(() => inputTriggers.registerSource(createConnectorMentionSource()), 'ui-hivemind-connect: lazy connector @ source')
    ctx.effect(() => inputTriggers.registerSource({
      trigger: '@', name: 'composer-actions', order: 0,
      showGroupTitle: false,
      candidates: async (_session, request) => composerActions.filter(action => `${action.name} ${action.token}`.toLowerCase().includes(request.query.toLowerCase())).map(action => ({ name: action.name, description: action.detail, value: action.token, icon: action.token === 'create-image' ? 'image' : action.token === 'schedule-task' ? 'schedule' : 'document' })),
      onPick: ({ candidate, session }) => {
        const actx = ctx.sessions.scope(session.sessionId)
        if (actx === undefined) return undefined
        const input = scope.conversation.input.for(actx)
        const draft = input.state.getSnapshot().draft.replace(/^@(create-image|schedule-task|create-pdf|create-document)\s*/, '')
        input.setDraft(`@${candidate.value} ${draft}`)
        return 'handled'
      },
      lexicon: () => composerActions.map(action => action.token),
    }), 'ui-hivemind-connect: action tag highlighting')
  })
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name',
    locale: NS,
  }, () => createElement('span', { 'data-hivemind-sidebar-brand': 'singulance' }, 'SINGULANCE')))
  ctx.effect(() => {
    const previous = document.title
    document.title = 'SINGULANCE · HIVE-MIND'
    return () => { document.title = previous }
  }, 'ui-hivemind-connect: white-label document title')
  const currentRoomIdentity = () => {
    const list = ctx.sessions.list.getSnapshot()
    const row = list.current === undefined ? undefined : list.byId[list.current]
    return roomIdentity(row?.projectionValues?.agentPreset ?? row?.agentPreset,
      row?.projectionValues?.hyperagentOwner ?? row?.projectionValues?.hyperagentSelection,
      list.current === undefined && window.location.pathname === '/hivemind/app/employee/harness')
  }
  const heroIdentity = {
    getSnapshot: () => JSON.stringify(currentRoomIdentity() ?? null),
    subscribe: (refresh: () => void) => ctx.sessions.list.subscribe(refresh),
  }
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, props => createElement(RoomHeroMark, { ...props, identity: heroIdentity })))
  ctx.effect(() => setupSingulanceHeadline(
    () => {
      const list = ctx.sessions.list.getSnapshot()
      return list.current === undefined ? undefined : list.byId[list.current]?.projectionValues?.agentPreset
    },
    refresh => ctx.sessions.list.subscribe(refresh), currentRoomIdentity,
  ), 'ui-hivemind-connect: Singulance hero headline')
  ctx.slots.inject('tool.call.toolview', function* () {
    const registration = (key: string) => ctx.slots.register({
      name: 'tool.call.toolview', key, locale: NS,
    }, ComposioConnectionCard)
    yield registration('hivemind_connected_task')
    yield registration('mcp__composio__COMPOSIO_MANAGE_CONNECTIONS')
  })
  ctx.effect(() => {
    if (document.documentElement.dataset.dshMode === 'hivemind-chat') {
      return setupHivemindSessionRouting(ctx.sessions)
    }
    let creating = false
    let disposed = false
    let pending: ReturnType<typeof setTimeout> | undefined
    const ensureSession = (): void => {
      const state = ctx.sessions.list.getSnapshot()
      if (state.current !== undefined || creating) return
      if (pending !== undefined) return
      pending = setTimeout(() => {
        pending = undefined
        if (disposed) return
        const settled = ctx.sessions.list.getSnapshot()
        if (settled.current !== undefined) return
        const existing = settled.ids[0]
        if (existing !== undefined) {
          ctx.sessions.open(existing)
          return
        }
        creating = true
        void ctx.sessions.create().then((sessionId) => {
          if (!disposed) ctx.sessions.open(sessionId)
        }).catch((reason: unknown) => {
          console.warn('HIVE-MIND session bootstrap failed:', reason)
        }).finally(() => {
          creating = false
          ensureSession()
        })
      }, state.phase === 'ready' ? 50 : 750)
    }
    const stop = ctx.sessions.list.subscribe(ensureSession)
    ensureSession()
    return () => {
      disposed = true
      if (pending !== undefined) clearTimeout(pending)
      stop()
    }
  }, 'ui-hivemind-connect: filesystem-free native session bootstrap')
}
