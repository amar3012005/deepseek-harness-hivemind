/** Host-attested task origin for one admitted native employee turn. */
import type { Agent } from '@deepseek-ai/dsh-agent'

export interface EmployeeWorkOrigin {
  readonly turn: number
  readonly rootId: string
  readonly taskId: string
  readonly itemId?: string
  readonly revision?: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Only written after authenticated assignment and task admission checks. */
    'hivemind/employee-work-origin': EmployeeWorkOrigin
  }
}

/** Read exact current-turn origin; later human answers cannot rewrite it.
 * An old assignment does not make a new direct-human turn delegated.
 * This receipt identifies origin only; every operation still rechecks authority.
 * @param agent - Exact native employee agent executing the current turn.
 * @returns Admitted assignment, or undefined for direct work.
 */
export function admittedEmployeeWork(agent: Agent): EmployeeWorkOrigin | undefined {
  const events = agent.session.ownEvents()
  const start = events.findLast(event => event.type === 'turn/start')
  if (start?.type !== 'turn/start') return undefined
  if (events.some(event => event.type === 'turn/end' && event.seq > start.seq
    && event.data.turn === start.data.turn)) return undefined
  const origin = events.findLast(event => event.type === 'hivemind/employee-work-origin'
    && event.seq > start.seq && event.data.turn === start.data.turn)
  return origin?.type === 'hivemind/employee-work-origin' ? origin.data : undefined
}
