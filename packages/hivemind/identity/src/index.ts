/** Authenticated HIVE-MIND identity capability. @module @deepseek-ai/dsh-hivemind-identity */

import { Context, Service } from '@deepseek-ai/cordis'

/** Tenant identity derived by HIVE-MIND from the active credential. */
export interface HiveMindTenantIdentity {
  readonly userId: string
  readonly orgId: string
}

/** Provider registered by the local authentication adapter. */
export interface HiveMindIdentityProvider {
  /** Resolve the currently authenticated tenant. */
  identity(signal: AbortSignal): Promise<HiveMindTenantIdentity>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hivemindIdentity: HiveMindIdentity
  }
}

/** Registry and resolver for the one active authenticated identity provider. */
export default class HiveMindIdentity extends Service {
  private provider: HiveMindIdentityProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'hivemindIdentity')
  }

  /** Register the authentication adapter for this composition. */
  register(provider: HiveMindIdentityProvider): () => void {
    if (this.provider !== undefined) throw new Error('hivemind-identity: provider already registered')
    this.provider = provider
    return () => {
      if (this.provider === provider) this.provider = undefined
    }
  }

  /** Resolve the authenticated user and organization without model-supplied tenant ids. */
  async resolve(signal: AbortSignal): Promise<HiveMindTenantIdentity> {
    if (this.provider === undefined) throw new Error('hivemind-identity: provider is unavailable')
    return this.provider.identity(signal)
  }
}
