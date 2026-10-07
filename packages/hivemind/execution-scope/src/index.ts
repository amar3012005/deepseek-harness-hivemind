/** Request-local HIVE principal propagated through HTTP dispatch and captured by durable handles. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Service, type Context } from '@deepseek-ai/cordis'

export interface HivemindPrincipal {
  readonly orgId: string
  readonly userId: string
  readonly profile: 'hivemind-chat'
  readonly variation: string
  readonly projectId?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context { hivemindExecutionScope: HivemindExecutionScope }
}

/** Holds only the principal associated with the active authenticated request chain. */
export default class HivemindExecutionScope extends Service {
  private readonly storage = new AsyncLocalStorage<HivemindPrincipal>()
  constructor(ctx: Context) { super(ctx, 'hivemindExecutionScope') }

  /** Run work with one immutable authenticated principal. */
  run<T>(principal: HivemindPrincipal, action: () => T): T {
    return this.storage.run(Object.freeze({ ...principal }), action)
  }

  /** Capture the active principal or fail closed outside an authenticated dispatch. */
  require(): HivemindPrincipal {
    const principal = this.storage.getStore()
    if (principal === undefined) throw new Error('hivemind execution scope is unavailable')
    return principal
  }
}

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
