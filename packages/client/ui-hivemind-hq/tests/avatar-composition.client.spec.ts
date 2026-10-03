// @vitest-environment jsdom
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { registerChatNodeRenderers } from '../../ui-chat/src/client/chat/register-node-renderers.ts'
import { apply } from '../src/client/index.ts'

it('composes actual chat and Runtime plan entries without duplicate avatar declarations', async () => {
  const core = new SlotCore()
  core.register({ name: 'root', children: {
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    'hivemind.runtime.plan': { kind: 'list', scope: 'session' },
  } } as never, (() => null) as never)
  const scope = {
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (options: { name: string }, component: unknown) => {
        if (options.name === 'conversation.chat.node' || options.name === 'hivemind.runtime.plan') {
          return core.register(options as never, component as never)
        }
        return () => {}
      },
    },
    remote: { $mount: async () => async () => {}, hivemindHq: {}, agentPresets: {} },
    locale: { register: () => () => {} },
    effect: () => {},
    sidebarRightTabs: { register: () => {} },
    sidebarRight: {}, sessions: {}, layout: {}, uiWorkspace: {},
    inject: (_names: unknown, callback: (context: unknown) => unknown) => {
      callback(scope)
      return async () => {}
    },
  }
  registerChatNodeRenderers(scope as unknown as Context)
  await expect(apply(scope as unknown as Context)).resolves.toBeTypeOf('function')
  for (const name of ['conversation.chat.assistantAvatar', 'conversation.chat.contextAvatar', 'hivemind.runtime.planAvatar']) {
    expect(() => core.register({ name } as never, (() => null) as never)).not.toThrow()
  }
})
