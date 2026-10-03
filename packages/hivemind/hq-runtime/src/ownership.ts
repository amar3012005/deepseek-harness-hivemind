/** Company ownership supplements, rather than replaces, native Session leases. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Authenticated backend must atomically retain one HQ root per company. */
export interface HqOwnershipBackend {
  /** Claim the calling human's company for an exact owned native HQ root. */
  freshTargets?(sessionId: SessionId): Promise<SessionId[]>
  resetFresh?(sessionId: SessionId, ids: readonly SessionId[]): Promise<{ sessions: number; memories: number }>
  claim(sessionId: SessionId): Promise<void>
}
declare module '@deepseek-ai/cordis' { interface Context { hivemindHqOwnership: HqOwnership } }

/** Native Cordis capability: models never receive the tenant or claim API. */
export default class HqOwnership extends Service {
  private backend: HqOwnershipBackend | undefined
  constructor(ctx: Context) { super(ctx, 'hivemindHqOwnership') }
  /** Register one deployment owner and remove it safely on plugin disposal. */
  register(backend: HqOwnershipBackend): () => void {
    if (this.backend) throw new Error('hq_ownership_backend_already_registered')
    this.backend = backend
    return () => { if (this.backend === backend) this.backend = undefined }
  }
  async freshTargets(sessionId: SessionId): Promise<SessionId[]> {
    if (!this.backend?.freshTargets) throw new Error('fresh_reset_backend_required')
    return this.backend.freshTargets(sessionId)
  }
  async resetFresh(sessionId: SessionId, ids: readonly SessionId[]): Promise<{ sessions: number; memories: number }> {
    if (!this.backend?.resetFresh) throw new Error('fresh_reset_backend_required')
    return this.backend.resetFresh(sessionId, ids)
  }
  /** Claim through authenticated storage; missing durability fails closed. */
  async claim(sessionId: SessionId): Promise<void> {
    if (!this.backend) throw new Error('hq_ownership_backend_required')
    await this.backend.claim(sessionId)
  }
}
