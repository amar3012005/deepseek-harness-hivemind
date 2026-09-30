/** Native header contribution over generated, tenant-authorized HQ Remote contracts. */
import { createElement, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import hqRemote from '@deepseek-ai/dsh-hivemind-hq-runtime/remote'
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
      const preset = useSyncExternalStore(listener => child.sessions.list.subscribe(listener),
        () => child.sessions.list.getSnapshot().byId[props.sessionId]?.projectionValues?.agentPreset
          ?? child.sessions.list.getSnapshot().byId[props.sessionId]?.agentPreset)
      return preset === 'hivemind-hq' ? createElement(HqControlAction, props) : null
    }
    child.slots.inject('conversation.session.header.actions', () => child.slots.register({
      name: 'conversation.session.header.actions', id: 'hivemind.hq-mode', order: 15, locale: 'hivemind.hq', inject: () => actions,
    }, ScopedControl))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
