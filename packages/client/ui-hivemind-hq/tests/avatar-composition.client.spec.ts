// @vitest-environment jsdom
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { presentationPolicyFor } from '../../ui-chat/src/client/presentation-policy.ts'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { registerChatNodeRenderers } from '../../ui-chat/src/client/chat/register-node-renderers.ts'
import { apply } from '../src/client/index.ts'

it('composes actual chat and Runtime plan entries without duplicate avatar declarations', async () => {
  const core = new SlotCore()
  core.register({ name: 'root', children: {
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
  } } as never, (() => null) as never)
  const scope = {
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      registerFactory: () => () => {},
      register: (options: { name: string }, component: unknown) => {
        if (options.name === 'conversation.chat.node' || options.name === 'conversation.chat.turnTail') {
          return core.register(options as never, component as never)
        }
        return () => {}
      },
    },
    remote: { $mount: async () => async () => {}, hivemindHq: {}, agentPresets: {} },
    locale: { register: () => () => {} },
    effect: (callback: () => unknown) => callback(),
    uiConversation: { events: { register: () => () => {} } },
    sidebarRightTabs: { register: () => {} },
    sidebarRight: {}, sessions: {}, layout: {}, uiWorkspace: {},
    inject: (_names: unknown, callback: (context: unknown) => unknown) => {
      callback(scope)
      return async () => {}
    },
  }
  registerChatNodeRenderers(scope as unknown as Context, createSnapshotStore('detailed' as const), createSnapshotStore(presentationPolicyFor('standard')))
  await expect(apply(scope as unknown as Context)).resolves.toBeTypeOf('function')
  for (const name of ['conversation.chat.assistantAvatar', 'conversation.chat.contextAvatar', 'hivemind.runtime.planAvatar', 'hivemind.employee.taskAvatar']) {
    expect(() => core.register({ name } as never, (() => null) as never)).not.toThrow()
  }
})
