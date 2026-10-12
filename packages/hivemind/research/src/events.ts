export type ResearchType = 'auto' | 'known_url' | 'focused_fact' | 'broad_discovery' | 'multi_hop' | 'legal_compliance' | 'connected_source'
import type {} from '@deepseek-ai/dsh-session/types'

export interface SubmittedResearch {
  jobId: string
  type: ResearchType
  route: string
  status: string
  runId?: string
  gatherId?: string
  workflowId?: string
  planId?: string
}
export interface ResearchSource { url: string; title?: string; excerpt?: string }
export interface ResearchReceipt {
  jobId: string
  runId?: string
  gatherId?: string
  workflowId?: string
  planId?: string
  status: string
  route?: string
  provider?: string
  resultCount?: number
  sources: ResearchSource[]
  evidenceState: 'pending' | 'ready' | 'partial' | 'unavailable'
  error?: string
}
export interface ResearchGatherReceipt {
  gatherId: string
  workflowId?: string
  runId?: string
  planId?: string
  workstreamId?: string
  status: 'succeeded' | 'partial' | 'failed'
  provider?: string
  objectives: readonly { objective: string; jobId: string; evidenceState: ResearchReceipt['evidenceState']; sourceCount: number; error?: string }[]
  sources: ResearchSource[]
}
export interface ResearchWorkflowStarted { workflowId: string; objective: string; status: 'running'; turn?: number }
export interface ResearchWorkflowTerminal {
  workflowId: string
  objective: string
  status: 'completed' | 'partial' | 'failed' | 'cancelled'
  evidenceState: 'ready' | 'partial' | 'unavailable'
  gatherId?: string
  sourceCount: number
  turn?: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records a submitted research job with route, status and associated run or workflow identities. */
    'hivemind/research-requested': SubmittedResearch & { objective: string }
    /** Records a research job outcome with sources, provider, evidence readiness and any error. */
    'hivemind/research-receipt': ResearchReceipt
    /** Records the combined research objectives, source evidence and terminal gather status. */
    'hivemind/research-gathered': ResearchGatherReceipt
    /** Records the research workflow objective, identity and running status. */
    'hivemind/research-workflow-started': ResearchWorkflowStarted
    /** Records the terminal research workflow status, evidence readiness and source count. */
    'hivemind/research-workflow-terminal': ResearchWorkflowTerminal
  }
}
