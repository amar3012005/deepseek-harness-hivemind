import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-session/types'

export interface OperatingContextRecorded {
  readonly runId: string
  readonly objective: string
  readonly companyContext: Record<string, JsonValue>
  readonly internalEvidence: Record<string, JsonValue>
  readonly playbookCandidates: readonly Record<string, JsonValue>[]
  readonly recommendedGlobalPlaybooks: readonly string[]
  readonly compatibleLocalPlaybooks: readonly string[]
  readonly employeeCandidates: readonly Record<string, JsonValue>[]
  readonly employeeExecution: {
    readonly defaultActorKind: 'inline_employee' | 'persistent_employee'
    readonly tool: 'hivemind_workstream' | 'hivemind_hq_contract'
    readonly childAgents: 'optional_escalation' | 'disabled_for_preset' | 'persistent_room_execution'
  }
  readonly capabilityGuidance: readonly string[]
  readonly likelyNeeds: readonly string[]
  readonly retrieval: {
    readonly companyContext: 'ready'
    readonly internalRecall: 'ready' | 'empty'
    readonly employeeDirectory: 'ready' | 'empty'
    readonly additionalRecallNeeded: boolean
    readonly additionalRecallReason: string
    readonly externalEvidenceLikelyNeeded: boolean
  }
}

export interface PlaybooksLoaded {
  readonly runId?: string
  readonly playbooks: readonly { readonly id: string; readonly version: string }[]
}

export type WorkstreamActorKind = 'main' | 'inline_employee' | 'employee_subagent' | 'dynamic_subagent' | 'workflow'

export interface PlannedWorkstream {
  readonly id: string
  readonly objective: string
  readonly actor: {
    readonly kind: WorkstreamActorKind
    readonly employeeId?: string
    readonly role?: string
  }
  readonly outcome?: string
  readonly approvalRequired?: boolean
}

export interface RunPlanRecorded {
  readonly runId: string
  readonly planId: string
  readonly revision: number
  readonly objective: string
  readonly playbooks: readonly { readonly id: string; readonly version: string; readonly reason: string }[]
  readonly approach: string
  readonly workstreams: readonly PlannedWorkstream[]
  readonly revisionReason?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records retrieved company context, evidence, candidate playbooks and employees, and retrieval readiness for an objective. */
    'hivemind/operating-context': OperatingContextRecorded
    /** Records the exact playbook identities and versions loaded for the run. */
    'hivemind/playbooks-loaded': PlaybooksLoaded
    /** Records the strategic plan revision, selected playbooks, approach and assigned workstreams. */
    'hivemind/run-plan': RunPlanRecorded
    /** Records a revised strategic plan with its revision reason and updated workstreams. */
    'hivemind/run-plan-revised': RunPlanRecorded
  }
}
