import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamId, TeamMessageId } from '@deepseek-ai/dsh-experimental-agent-team'
import { activeTeamWait, fulfillTeamWait } from '../src/parked-wait.ts'

const callId = ToolCallId('wait-1')
const teamId = TeamId('lead')
function fixture() {
  const session = Session.create(SessionId('lead'))
  session.append('turn/start', { turn: 1 })
  session.append('team/wait/parked', { callId, teamId, expectedSenderIds: ['employee'], originalSourceMessageId: 'nightly-occurrence' })
  session.append('turn/end', { turn: 1, reason: { type: 'completed' } })
  return { session } as unknown as Agent
}
function reply(agent: Agent, senderId = 'employee', targetTeam = teamId) {
  agent.session.append('user/message', createUserMessage({
    source: { kind: 'team-message', teamId: targetTeam, messageId: TeamMessageId('reply-1'), senderId: SessionId(senderId), senderName: senderId },
    content: [{ type: 'text', text: 'Completed the review.' }],
  }), { surfaceOp: 'append' })
}
describe('durable Team reply checkpoint', () => {
  it('retains exact wait and original occurrence through serialized cold reconstruction', () => {
    const agent = fixture()
    const restored = JSON.parse(JSON.stringify(agent.session.snapshotEvents()))
    expect(activeTeamWait(restored)).toEqual({ callId, teamId, expectedSenderIds: ['employee'], originalSourceMessageId: 'nightly-occurrence' })
  })
  it('settles only after a same-Team expected sender, once, without creating a human answer', () => {
    const agent = fixture()
    reply(agent, 'foreign')
    expect(fulfillTeamWait(agent)).toBeUndefined()
    reply(agent, 'employee', TeamId('foreign-team'))
    expect(fulfillTeamWait(agent)).toBeUndefined()
    reply(agent)
    expect(fulfillTeamWait(agent)?.callId).toBe(callId)
    expect(fulfillTeamWait(agent)).toBeUndefined()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'team/wait/fulfilled')).toHaveLength(1)
  })
})
