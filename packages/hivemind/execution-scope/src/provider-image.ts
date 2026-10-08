import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Scoped } from '@deepseek-ai/dsh-scope'

/** Host-only provider facade invocation, dispatched through the owning agent fiber. */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Generate an image through the owning agent's configured native provider.
     * @param input - Agent, prompt, durable operation identity and cancellation.
     * @mode serial
     */
    'hivemind/provider-image'(this: Scoped<Agent>, input: { agent: Agent; prompt: string; sessionId: string; operationId: string; signal: AbortSignal; transparentBackground?: boolean }): Promise<{ data: Uint8Array; mediaType: string }>
  }
}
