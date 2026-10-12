import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-session/types'

export interface SelectedPlaybook { readonly id: string; readonly version: string }

export interface EmployeeDelegationStart {
  readonly delegationId: string
  readonly panelId?: string
  readonly jobId?: string
  readonly executionState?: 'pending'
  readonly workstreamId?: string
  readonly employeeId: string
  readonly employeeName: string
  readonly role: string
  readonly profileVersion?: string
  readonly personaSha256: string
  readonly provider: string
  readonly task: string
  readonly reason: string
  readonly requestedOutput?: string
  readonly acceptanceCriteria: readonly string[]
  readonly selectedPlaybooks: readonly SelectedPlaybook[]
  readonly parentRun: { readonly sessionId: string; readonly runId?: string; readonly planSeq?: number }
  readonly budget: { readonly maxOutputTokens: number; readonly maxDurationMs: number; readonly maxDepth: number }
  readonly modelRoute: {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly maxTokens?: number
  }
  readonly effectiveToolPolicy: { readonly deny: readonly string[] }
  readonly profilePolicySha256?: string
  readonly personaContractSha256?: string
  readonly profileToolsSha256?: string
}

export interface EmployeeDelegationEnd {
  readonly delegationId: string
  readonly panelId?: string
  readonly workstreamId?: string
  readonly employeeId: string
  readonly childSessionId?: string
  readonly status: 'completed' | 'failed'
  readonly stopReason?: SubagentStopReason
  readonly diagnostic?: string
  readonly outputSha256?: string
  readonly outputChars?: number
  readonly outputPreview?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records an employee assignment with task, acceptance criteria, selected playbooks, model route and policy identity. */
    'hivemind/employee-delegation-start': EmployeeDelegationStart
    /** Records the delegation outcome with employee and child-session identity, stop reason and output digest. */
    'hivemind/employee-delegation-end': EmployeeDelegationEnd
  }
}
