import type { PlannedWorkstream } from '@deepseek-ai/dsh-hivemind-playbooks/events'
import type {} from '@deepseek-ai/dsh-session/types'

export interface WorkstreamActorSnapshot {
  readonly kind: PlannedWorkstream['actor']['kind']
  readonly employeeId?: string
  readonly employeeName?: string
  readonly role?: string
  readonly avatarUrl?: string
  readonly profileVersion?: string
  readonly personaSha256?: string
}

export interface WorkstreamStarted {
  readonly runId: string
  readonly planId: string
  readonly planRevision: number
  readonly workstreamId: string
  readonly objective: string
  readonly outcome?: string
  readonly actor: WorkstreamActorSnapshot
  readonly approvalRequired?: boolean
}
export interface WorkstreamProgress {
  readonly runId: string
  readonly planId: string
  readonly workstreamId: string
  readonly summary: string
}
export interface WorkstreamCompleted {
  readonly runId: string
  readonly planId: string
  readonly workstreamId: string
  readonly summary: string
  readonly evidenceIds: readonly string[]
  readonly artifactIds: readonly string[]
}
export interface WorkstreamFailed {
  readonly runId: string
  readonly planId: string
  readonly workstreamId: string
  readonly diagnostic: string
}
export interface WorkstreamApproval {
  readonly runId: string
  readonly planId: string
  readonly workstreamId: string
  readonly outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  readonly reason: string
  readonly authority?: 'human_approval' | 'permission_preset'
}
export interface EvidenceGapRecorded {
  readonly runId: string
  readonly planId: string
  readonly workstreamId: string
  readonly summary: string
}
export interface OperatingReceipt {
  readonly runId: string
  readonly planId: string
  readonly receiptId: string
  readonly kind: 'browser' | 'artifact' | 'workflow' | 'connected_action'
  readonly status: 'running' | 'completed' | 'failed'
  readonly title: string
  readonly toolName?: string
  readonly callId?: string
  readonly summary?: string
}
export interface RunEvaluation {
  readonly runId: string
  readonly planId: string
  readonly status: 'ready'
  readonly receiptCounts: Readonly<Record<string, number>>
  readonly next: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records the admitted workstream objective, actor and originating plan revision. */
    'hivemind/workstream-started': WorkstreamStarted
    /** Records a workstream progress summary correlated with its run and plan. */
    'hivemind/workstream-progress': WorkstreamProgress
    /** Records a completed workstream summary and supporting evidence and artifact identities. */
    'hivemind/workstream-completed': WorkstreamCompleted
    /** Records a workstream failure diagnostic correlated with its run and plan. */
    'hivemind/workstream-failed': WorkstreamFailed
    /** Records the workstream approval outcome, reason and authority without inferring human authorization. */
    'hivemind/workstream-approval': WorkstreamApproval
    /** Records an unresolved evidence gap for a specific run, plan and workstream. */
    'hivemind/evidence-gap-recorded': EvidenceGapRecorded
    /** Records the status and identity of a browser, artifact, workflow or connected-action receipt. */
    'hivemind/operating-receipt': OperatingReceipt
    /** Records a ready run evaluation with receipt counts and the proposed next action. */
    'hivemind/run-evaluation': RunEvaluation
  }
}
