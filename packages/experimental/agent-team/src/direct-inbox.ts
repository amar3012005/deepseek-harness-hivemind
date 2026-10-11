/** Matched dsh-v0.2.1-alpha.2 direct native Inbox delivery, preserving HIVE room authority. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import { resolveActiveMember } from './roster.ts'
import type { TeamRoster } from './roster.ts'
import type { SendTeamMessageRequest, SendTeamMessageResult } from './types.ts'

/** Deliver once under exact live membership; independent employees retain their scoped RoomMessaging protocol. */
export async function directTeamMessage(
  ctx: Context, roster: TeamRoster, journal: TeamJournal, caller: Agent,
  request: SendTeamMessageRequest, maxMessageBytes: number,
): Promise<SendTeamMessageResult> {
  const membership = roster.membership(caller)
  request.signal.throwIfAborted()
  const { root } = membership
  const state = journal.state(root)
  const target = resolveActiveMember(root, state, request.target)
  if (state.members.find(member => member.id === target.id)?.ownership === 'persistent') {
    throw new TeamError('persistent assignees use their host room mailbox', 'TEAM_INVALID_TARGET')
  }
  if (target.id === caller.id) throw new TeamError('a Team member cannot message itself', 'TEAM_SELF_MESSAGE')
  const content = [{ type: 'text' as const, text: `Team message from ${membership.name}:` }, ...structuredClone(request.content)]
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > maxMessageBytes) {
    throw new TeamError(`team message exceeds ${maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE')
  }
  const source = { kind: 'agent-message' as const, form: 'relay' as const, senderSessionId: caller.id }
  if (target.id === root.id) {
    const input = createUserMessage({ content, source })
    root.steer(input)
    return { messageId: input.id }
  }
  return { messageId: await steerHostSubagentPrompt(ctx.subagents, root, target.id, content, source, request.signal) }
}
