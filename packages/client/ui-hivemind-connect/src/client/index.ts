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
import { setupSingulanceHeadline, SingulanceMark } from './SingulanceMark.tsx'
import { setupHivemindSessionRouting } from './session-route.ts'
import { setupConnectionCallbackReturn } from './connection-callback.ts'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createElement } from 'react'
import { ScopeSelect, type HivemindReadScope } from './ScopeSelect.tsx'
import { ConnectorChips, type ConnectorChipsProps } from './ConnectorChips.tsx'
import { createConnectorMentionSource } from './ConnectorMentions.ts'
import { ContextualFollowUps, selectContextualFollowUps } from './ContextualFollowUps.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'hivemind-connect': HivemindConnectKey }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'hivemind/read-scope': { scope: HivemindReadScope; project?: string }
    'hivemind/reply-language': { language: string }
  }
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
    const normalize = (value: unknown): string => {
      const match = typeof value === 'string' ? value.toLowerCase().match(/^[a-z]{2}/u) : null
      return match?.[0] ?? 'en'
    }
    let selected = normalize(document.documentElement.lang)
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
    const onLanguage = (event: Event): void => {
      selected = normalize((event as CustomEvent<{ language?: unknown }>).detail.language)
      sync()
    }
    const stop = ctx.sessions.list.subscribe(sync)
    window.addEventListener('hivemind:ui-language', onLanguage)
    sync()
    return () => {
      disposed = true
      stop()
      window.removeEventListener('hivemind:ui-language', onLanguage)
    }
  }, 'ui-hivemind-connect: navbar reply language')
  ctx.inject(['uiConversation'], (scope: ClientContext) => {
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
  ctx.inject(['conversation'], () => {
    ctx.slots.inject('conversation.hero.dock', () => ctx.slots.register({
      name: 'conversation.hero.dock',
      id: 'hivemind-connector-suggestions',
      order: -20,
      inject: (): ConnectorChipsProps => {
        const sessionId = ctx.sessions.list.getSnapshot().current
        if (sessionId === undefined) return { insertMention: () => {}, visible: false }
        const scope = ctx.sessions.scope(sessionId)
        if (scope === undefined) throw new Error(`HIVE-MIND connector chips: session "${sessionId}" resolved no scope`)
        const conversation = scope.get('conversation')
        if (conversation === undefined) throw new Error('HIVE-MIND connector chips: conversation service unavailable')
        const input = conversation.input.for(scope)
        return {
          insertMention: (chip) => {
            const snapshot = input.state.getSnapshot()
            const end = snapshot.draft.length
            input.insertReference(chip, { start: end, end, draftRev: snapshot.draftRev })
          },
        }
      },
    }, ConnectorChips))
    const sendFollowUp = (prompt: string): void => {
      const sessionId = ctx.sessions.list.getSnapshot().current
      const scope = sessionId === undefined ? undefined : ctx.sessions.scope(sessionId)
      const conversation = scope?.get('conversation')
      if (conversation !== undefined) void conversation.send(prompt)
    }
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail', priority: 40,
      select: selectContextualFollowUps,
    }, ({ matched }) => createElement(ContextualFollowUps, { matched, send: sendFollowUp })))
  })
  ctx.inject(['inputTriggers'], (scope: ClientContext) => {
    const inputTriggers = scope.get('inputTriggers') as {
      registerSource(source: ReturnType<typeof createConnectorMentionSource>): () => void
    } | undefined
    if (inputTriggers === undefined) return
    ctx.effect(() => inputTriggers.registerSource(createConnectorMentionSource()), 'ui-hivemind-connect: lazy connector @ source')
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
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, SingulanceMark))
  ctx.effect(setupSingulanceHeadline, 'ui-hivemind-connect: Singulance hero headline')
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
