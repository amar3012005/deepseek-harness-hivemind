import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installBrainGatewayRepair } from '../src/brain-gateway-repair.ts'

it('repairs only the old Brain route through native model selection', async () => {
  let handler: (input: unknown, next: () => Promise<unknown>) => Promise<unknown> = async () => undefined
  const selectModel = vi.fn(async () => ({}))
  const scope = {
    inject: (_names: string[], apply: (ctx: unknown) => void) => apply(scope),
    effect: (apply: () => unknown) => apply(),
    on: (_event: string, callback: typeof handler) => { handler = callback },
    sessionController: { selectModel },
  }
  installBrainGatewayRepair(scope as unknown as Context)
  const actor = (preset: string, provider: string) => ({ agent: { session: {
    id: 'existing-room', header: { agentPreset: preset }, snapshotEvents: () => [],
    requestHeader: () => ({ config: { provider } }),
  } } })
  const next = async () => ({ kind: 'enter', messages: [] })
  await handler(actor('hivemind-hq', 'cloudflare-openrouter-streaming'), next)
  await handler(actor('hivemind-chat', 'cloudflare-workers-ai'), next)
  expect(selectModel).not.toHaveBeenCalled()
  await handler(actor('hivemind-chat', 'cloudflare-openrouter-streaming'), next)
  expect(selectModel).toHaveBeenCalledWith({ sessionId: 'existing-room', provider: 'cloudflare-workers-ai',
    model: '@cf/zai-org/glm-5.3-flash', reasoningEffort: 'low' })
})
