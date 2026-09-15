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
import { DefaultModelLabel } from './DefaultModelLabel.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'hivemind-connect': HivemindConnectKey }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'hivemind/read-scope': { scope: HivemindReadScope; project?: string }
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
  ctx.inject(['uiConversation'], (scope: ClientContext) => {
    scope.effect(
      () => scope.uiConversation.configureWorkspaceRequirement(false),
      'ui-hivemind-connect: filesystem-free conversation',
    )
  })
  ctx.slots.inject('conversation.input.scope', () => ctx.slots.register({
    name: 'conversation.input.scope',
    locale: NS,
  }, ({ sessionId, locked }: { sessionId: SessionId; locked: boolean }) => {
    const key = `hivemind:read-scope:${sessionId}`
    let initialScope: HivemindReadScope = 'full'
    try {
      const stored = sessionStorage.getItem(key)
      if (stored === 'personal' || stored === 'organization' || stored === 'project' || stored === 'full') initialScope = stored
    } catch { /* storage can be unavailable in embedded contexts; full is safe */ }
    const onSelect = (id: SessionId, readScope: HivemindReadScope, project?: string): void => {
      try { sessionStorage.setItem(key, readScope) } catch { /* durable session event remains authoritative */ }
      const scoped = ctx.sessions.scope(id)
      const session = scoped === undefined ? undefined : ctx.sessions.sessionOf(scoped)
      if (session === undefined) return
      const argument = project === undefined ? readScope : `${readScope} ${project}`
      void session.command(`/hivemind-scope ${argument}`)
    }
    return createElement(ScopeSelect, { sessionId, locked, initialScope, onSelect })
  }))
  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
    name: 'conversation.input.model',
    locale: NS,
  }, DefaultModelLabel))
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
