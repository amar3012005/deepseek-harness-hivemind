/** Bounded native direct Team Inbox evidence; legacy queued rows remain readable. */
import type {} from '@deepseek-ai/dsh-subagent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
export function directTeamMessageBriefing(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'user/message' && event.data.source.kind === 'agent-message'
    && event.data.source.form === 'relay').slice(-12).map((event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'agent-message') throw new Error('unexpected_native_team_message')
    return { id: event.data.id, sender: event.data.source.senderSessionId,
      text: event.data.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('\n').slice(0, 320) }
  })
}
