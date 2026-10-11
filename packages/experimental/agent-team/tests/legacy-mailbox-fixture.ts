/** Test-only pre-upgrade producer. New production Team sends cannot enqueue legacy rows. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamMailbox } from '../src/mailbox.ts'
import type { TeamJournal } from '../src/journal.ts'
import type { TeamRuntimeLifecycle } from '../src/lifecycle.ts'
import type { TeamRoster } from '../src/roster.ts'
import { resolveActiveMember } from '../src/roster.ts'
import { TeamError } from '../src/error.ts'
import { TeamId, TeamMessageId } from '../src/types.ts'
import type { SendTeamMessageRequest, TeamMessageSnapshot } from '../src/types.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
class LegacyProducerFixture extends TeamMailbox {
  constructor(private readonly fixtureJournal: TeamJournal, private readonly fixtureRoster: TeamRoster,
    private readonly fixtureLifecycle: TeamRuntimeLifecycle, private readonly maxPendingMessagesPerMember: number,
    private readonly maxMessageBytes: number, ctx: Context) { super(ctx, fixtureJournal, fixtureRoster, fixtureLifecycle) }
  private get native() {
    return this as unknown as {
      trackDispatch<T>(operation: Promise<T>): Promise<T>
      tryDispatch(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean>
    }
  }
  private fixtureDeliveryContent(message: TeamMessageSnapshot): ContentBlock[] {
    return [{ type: 'text', text: `Team message ${message.id} from ${message.senderName}:` }, ...structuredClone(message.content)]
  }
  async send(caller: Agent, request: SendTeamMessageRequest): Promise<{ messageId: TeamMessageId; status: 'accepted' | 'queued' }> {
    if (this.fixtureLifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    const operation = this.sendAdmitted(caller, {
      ...request,
      signal: AbortSignal.any([request.signal, this.fixtureLifecycle.signal]),
    })
    return await this.native.trackDispatch(operation)
  }

  private async sendAdmitted(
    caller: Agent,
    request: SendTeamMessageRequest,
  ): Promise<{ messageId: TeamMessageId; status: 'accepted' | 'queued' }> {
    const membership = this.fixtureRoster.membership(caller)
    request.signal.throwIfAborted()
    const root = membership.root
    const content = structuredClone(request.content)
    const queued = await this.fixtureJournal.transact(root.id, async () => {
      request.signal.throwIfAborted()
      const state = this.fixtureJournal.state(root)
      const target = resolveActiveMember(root, state, request.target)
      if (state.members.find(member => member.id === target.id)?.ownership === 'persistent') throw new TeamError('persistent assignees use their host room mailbox', 'TEAM_INVALID_TARGET')
      if (target.id === caller.id) throw new TeamError('a Team member cannot message itself', 'TEAM_SELF_MESSAGE')
      const pendingForTarget = state.messages.filter(candidate =>
        candidate.targetId === target.id && !state.delivered.includes(candidate.id)).length
      if (pendingForTarget >= this.maxPendingMessagesPerMember) {
        throw new TeamError(
          `teammate "${target.name}" has ${pendingForTarget} pending messages`,
          'TEAM_MAILBOX_FULL',
        )
      }
      const queued: TeamMessageSnapshot = {
        id: TeamMessageId(`team-message-${randomUUID()}`),
        senderId: caller.id,
        senderName: membership.name,
        targetId: target.id,
        content,
      }
      if (Buffer.byteLength(JSON.stringify(this.fixtureDeliveryContent(queued)), 'utf8') > this.maxMessageBytes) {
        throw new TeamError(`team message exceeds ${this.maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE')
      }
      await this.fixtureJournal.appendAndFlush(root, 'team/message/queued', {
        version: 2,
        teamId: TeamId(root.id),
        message: queued,
      })
      // Register dispatch before releasing the root transaction so concurrent
      // senders enter the target-local queue in durable mailbox order.
      return { message: queued, dispatch: this.native.tryDispatch(root, queued, request.signal) }
    })
    const accepted = await queued.dispatch
    return { messageId: queued.message.id, status: accepted ? 'accepted' : 'queued' }
  }

}
/** Replace the private recovery owner only in old producer tests; disposal still tracks its native operations. */
export function legacyMailbox(ctx: Context): LegacyProducerFixture {
  const service = ctx.agentTeams as unknown as {
    mailbox: TeamMailbox
    journal: TeamJournal
    roster: TeamRoster
    lifecycle: TeamRuntimeLifecycle
    config: { maxPendingMessagesPerMember: number; maxMessageBytes: number }
  }
  if (!(service.mailbox instanceof LegacyProducerFixture)) service.mailbox = new LegacyProducerFixture(service.journal, service.roster,
    service.lifecycle, service.config.maxPendingMessagesPerMember, service.config.maxMessageBytes, ctx)
  return service.mailbox as LegacyProducerFixture
}
