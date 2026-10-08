import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

export interface DelegatedConnectionRequest {
  readonly execution: ToolExecution
  readonly workflowSessionId: string
  readonly routerSessionId: string
  readonly toolkits: readonly string[]
  readonly redirectUrl?: string
}
export interface DelegatedConnectionReceipt {
  readonly status: 'blocked_reported'
  readonly blocker_id: string
  readonly task_id: string
  readonly checkpoint_id: string
  readonly message_id: string
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Report only a verified native Runtime assignment. @mode serial */
    'hivemind/delegated-connection-blocker'(input: DelegatedConnectionRequest): Promise<DelegatedConnectionReceipt | undefined>
    /** Verify original workflow and fresh account state before resuming. @mode serial */
    'hivemind/delegated-connection-verify'(input: {
      runtime: Agent
      employee: Agent
      workflowSessionId: string
      routerSessionId: string
      toolkits: readonly string[]
      signal: AbortSignal
    }): Promise<boolean | undefined>
  }
}
