/** Native operator-policy snapshot emission; permission admission remains independently checked. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const POLICY = 'The administrator explicitly selected native Full access for Runtime. Within existing organization credentials and provider API scopes, ' +
  'plan and delegate bounded useful work without asking again for routine permission, including applicable app/project and company-memory save decisions. ' +
  'This covers only existing native exemptions for connected-app writes, project and applicable app saves, company-memory saves and listed research tools. ' +
  'It is not blanket approval: residual native asks under approval=never are rejected, and downstream deny checks still apply. ' +
  'Preserve confirmed user direction, attribution and all tenant/credential/deny guards. Missing connections and essential facts are real blockers: ' +
  'report them through Runtime and ask only what changes the decision. Direct-human employee work keeps its own permissions.'

/**
 * Emit the existing policy once per admitted turn or actual authority change.
 * @param ctx - Native agent event scope.
 * @param allowed - Existing authenticated permission check, called at every admitted step.
 */
export function installFullAccessPolicySnapshot(
  ctx: Context, allowed: (agent: Agent, signal: AbortSignal) => Promise<boolean>,
): void {
  const emitted = new WeakMap<Agent, { turn: number; allowed: boolean }>()
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const admitted = await allowed(agent, signal)
    const saved = agent.session.deriveMessages().findLast(message => message.source?.kind === 'plugin'
      && message.source.plugin === 'hivemind-runtime-full-access')
    const previous = emitted.get(agent) ?? (saved === undefined ? undefined : { turn: turn - 1, allowed: saved.content.some(block => block.type === 'text' && block.text === POLICY) })
    emitted.set(agent, { turn, allowed: admitted })
    if ((!admitted && !previous?.allowed)
      || (previous?.turn === turn && previous.allowed === admitted)) return decision
    const text = admitted ? POLICY : 'Native Full access is no longer admitted for this request; the current native permission policy applies.'
    return { ...decision, messages: [...decision.messages, createUserMessage({
      source: { kind: 'plugin', plugin: 'hivemind-runtime-full-access', form: 'snapshot',
        sections: [{ name: 'native-full-access-policy', text }] },
      content: [{ type: 'text', text }],
    })] }
  }))
}
