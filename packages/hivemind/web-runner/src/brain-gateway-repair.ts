import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent'

/** Repair only historical Brain routes using this revision's public native selector. */
export function installBrainGatewayRepair(ctx: Context): void {
  ctx.inject(['sessionController'], (scope) => {
    scope.effect(() => scope.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      let preset = agent.session.header.agentPreset
      for (const event of agent.session.snapshotEvents()) {
        if (String(event.type) === 'agent-preset/selected') preset = (event.data as { agentPreset: string }).agentPreset
      }
      if (preset !== 'hivemind-chat') return decision
      const events = agent.session.snapshotEvents()
      const pending = events.findLast(event => event.type === 'model/selection')
      const provider = pending?.type === 'model/selection' ? pending.data.provider : agent.session.requestHeader()?.config.provider
      if (provider !== 'cloudflare-openrouter-streaming' && provider !== 'cloudflare-openrouter') return decision
      await scope.sessionController.selectModel({ sessionId: agent.session.id,
        provider: 'cloudflare-workers-ai', model: '@cf/zai-org/glm-5.3-flash', reasoningEffort: 'low' })
      return decision
    }))
  })
}
