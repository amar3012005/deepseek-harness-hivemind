/** Request-local HIVE principal propagated through HTTP dispatch and captured by durable handles. */
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
