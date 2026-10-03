/** Public-only diagnostics must not leak into later operating turns. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export function investigationExpired(events: readonly SessionEvent[], turn: number): boolean {
  const scope = events.findLast(event => event.type === 'hivemind/hq-public-investigation')
  if (scope?.type !== 'hivemind/hq-public-investigation' || !scope.data.enabled) return false
  const firstTurn = events.find(event => event.type === 'turn/start' && event.seq > scope.seq)
  return firstTurn?.type === 'turn/start' && firstTurn.data.turn < turn
}
