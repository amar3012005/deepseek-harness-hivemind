/** Shared existing social-intent projection; never grants authority. */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** A conversational greeting carries no operational wake or changed task. */
export function greetingOnly(messages: readonly UserMessage[]): boolean {
  const passive = new Set(['hivemind-hq/wake-briefing', 'dsh-hivemind-runtime/turn', 'dsh-hivemind-runtime/history',
    'dsh-hivemind-connected-apps/workflow', 'dsh-hivemind-connected-apps/receipt',
    'hivemind-runtime/hq-private-recall', 'hivemind-web-runner/authenticated-initiator', 'hivemind-runtime-full-access', 'time-context'])
  const humans = messages.filter(message => message.source.kind === 'user')
  const human = humans[0]
  return humans.length === 1 && human !== undefined && messages.every(message => message.source.kind === 'user'
    || (message.source.kind === 'plugin' && passive.has(message.source.plugin)))
    && human.content.every(block => block.type === 'text')
    && !/\b(?:and|then)\b/iu.test(human.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    && new RegExp('^(?:(?:hi+|hey+|hello+|good morning|good afternoon|good evening|thanks|thank you)[!.\\s]*'
      + '|(?:say (?:hi|hello) to|greet) [\\p{L}\\p{N}_ -]{1,80}[!.]?)$', 'iu').test(
      human.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim(),
    )
}

/** Preserve the current social intent across native model/tool steps. */
export function socialTurnOnly(current: readonly SessionEvent[], fresh: readonly UserMessage[] = []): boolean {
  const admitted = [...new Map([...current.flatMap(event => event.type === 'user/message' ? [event.data] : []),
    ...fresh].map(message => [message.id, message])).values()]
  // A reply to this turn's own social message closes that exchange. It is
  // not fresh company work, even when it arrives before the turn commits.
  const direct = admitted.filter((message) => {
    if (String(message.source.kind) !== 'hivemind-agent-message') return true
    try {
      const packet = JSON.parse(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) as {
        id?: string
        kind?: string
        replyTo?: string
        senderId?: string
        taskId?: string
        artifactIds?: string[]
      }
      const outgoing = current.find(event => String(event.type) === 'hivemind/room-message-queued'
        && (event.data as { id?: string }).id === packet.replyTo)?.data as {
          targetId?: string
          taskId?: string
          artifactIds?: string[]
        } | undefined
      if (packet.kind !== 'reply' || !packet.id || !outgoing || outgoing.targetId !== packet.senderId
        || packet.taskId || outgoing.taskId || packet.artifactIds?.length || outgoing.artifactIds?.length) return true
      return false
    } catch { return true }
  })
  return greetingOnly(direct) && current.filter(event => event.type === 'tool/call').every((event) => {
    if (event.type !== 'tool/call') return false
    let args: Record<string, unknown>
    try { args = JSON.parse(event.data.arguments) } catch { return false }
    if (event.data.name === 'list_agents') return true
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false
    if (event.data.name === 'hivemind_hq_contract') return args.action === 'list'
    return event.data.name === 'hivemind_agent_message' && !args.task_id
      && (!Array.isArray(args.artifact_ids) || args.artifact_ids.length === 0)
      && ((args.kind === 'update' && !args.reply_to)
        || args.kind === 'reply')
  })
}
