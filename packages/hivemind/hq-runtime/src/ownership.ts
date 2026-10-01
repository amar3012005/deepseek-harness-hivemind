/** Company ownership supplements, rather than replaces, native Session leases. */
import type { HqActivity } from './continuity.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Authenticated backend must atomically retain one HQ root per company. */
export interface HqOwnershipBackend {
  /** Claim the calling human's company for an exact owned native HQ root. */
  claim(sessionId: SessionId): Promise<void>
  find?(): Promise<SessionId | undefined>
  companyEvidence?(sessionId: SessionId, artifactId?: string): Promise<Record<string, JsonValue>>
  activity?(sessionId: SessionId, reviewed: Readonly<Record<string, number>>, limit: number):
  Promise<{ items: HqActivity[]; hasMore: boolean }>
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
  /** Resolve the authenticated company's existing persistent HQ.
   * @returns canonical native session identity when initialized.
   */
  async find(): Promise<SessionId | undefined> {
    if (!this.backend?.find) throw new Error('hq_ownership_lookup_required')
    return this.backend.find()
  }
  /** Read existing company baseline/plan artifacts through authenticated storage.
   * @param sessionId - canonical HQ root.
   * @param artifactId - exact listed artifact to load; omission lists bounded references.
   * @returns authorized source references or one bounded artifact payload.
   */
  async companyEvidence(sessionId: SessionId, artifactId?: string): Promise<Record<string, JsonValue>> {
    if (!this.backend?.companyEvidence) return { status: 'unavailable', reason: 'company_evidence_provider_unavailable' }
    return this.backend.companyEvidence(sessionId, artifactId)
  }
  /** Read unreviewed native outcomes under existing tenant authorization.
   * @param sessionId - canonical HQ root.
   * @param reviewed - acknowledged per-session sequences.
   * @param limit - maximum outcome references.
   * @returns next batch and whether more authorized outcomes remain.
   */
  async activity(sessionId: SessionId, reviewed: Readonly<Record<string, number>>, limit: number):
  Promise<{ items: HqActivity[]; hasMore: boolean }> {
    if (!this.backend?.activity) throw new Error('hq_activity_provider_required')
    return this.backend.activity(sessionId, reviewed, limit)
  }
  /** Claim through authenticated storage; missing durability fails closed. */
  async claim(sessionId: SessionId): Promise<void> {
    if (!this.backend) throw new Error('hq_ownership_backend_required')
    await this.backend.claim(sessionId)
  }
}
