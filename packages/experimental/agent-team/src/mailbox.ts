/** Durable Team mailbox admission, target-local dispatch, acknowledgement, and recovery. */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { errorMessage } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import { readPersistedSession } from './persisted.ts'
import type { TeamRoster } from './roster.ts'
import { messageAccepted } from './session-message.ts'
import { TeamId, TeamMessageId } from './types.ts'
import type {
  TeamMessageSnapshot,
} from './types.ts'

/** Owns every process-local state transition for the durable Team mailbox. */
export class TeamMailbox {
  private readonly dispatchTails = new Map<SessionId, Promise<void>>()
  private readonly inFlightMessages = new Set<TeamMessageId>()
  private readonly inFlightDispatches = new Set<Promise<unknown>>()

  /**
   * @param ctx - Team service context with Agent, Session, persistence, and subagent services.
   * @param journal - authoritative Lead-log transaction owner.
   * @param roster - Team membership and member-name resolver.
   * @param lifecycle - shared Team runtime admission cutoff.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly roster: TeamRoster,
    private readonly lifecycle: TeamRuntimeLifecycle,
  ) {}

  /**
   * Observe target-side durable receipts and checkpoint their Lead-log acknowledgement.
   * @param session - exact target Session receiving the event.
   * @param event - newly appended Session event.
   */
  observeSessionEvent(session: Session, event: SessionEvent): void {
    if (this.lifecycle.disposed || event.type !== 'user/message' || event.data.source.kind !== 'team-message') return
    const source = event.data.source
    const acknowledgement = Promise.resolve().then(async () => {
      const root = this.ctx.agents.get(brandString<SessionId>(source.teamId))
      if (root !== undefined) await this.checkpointDelivered(root, session, source.messageId)
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`Team message "${source.messageId}" acknowledgement failed: ${errorMessage(error)}`)
    })
    void this.trackDispatch(acknowledgement)
  }

  /**
   * Retry durable pending messages relevant to one started Team member.
   * @param agent - newly started exact live Agent.
   * @param signal - shared runtime cancellation.
   */
  async recoverFor(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const membership = this.roster.tryMembership(agent)
    if (membership === undefined) return
    const state = this.journal.state(membership.root)
    const messages = state.messages.filter(message =>
      !state.delivered.includes(message.id)
      && (membership.role === 'lead' || message.targetId === agent.id)).slice(0, 64)
    for (const message of messages) {
      signal.throwIfAborted()
      await this.tryDispatch(membership.root, message, signal)
    }
  }

  /**
   * Return admitted dispatch and acknowledgement operations captured for disposal.
   * @returns detached snapshot ordered only by Set insertion.
   */
  pendingDispatches(): readonly Promise<unknown>[] {
    return [...this.inFlightDispatches]
  }

  /** Attempt one queued message exactly once in this process at a time. */
  private tryDispatch(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean> {
    if (this.lifecycle.disposed) return Promise.resolve(false)
    if (this.inFlightMessages.has(message.id)) return Promise.resolve(false)
    this.inFlightMessages.add(message.id)
    const operation = this.trackDispatch(
      this.tryDispatchAdmitted(
        root,
        message,
        AbortSignal.any([signal, this.lifecycle.signal]),
      ),
    )
    const forget = (): void => {
      this.inFlightMessages.delete(message.id)
    }
    void operation.then(forget, forget)
    return operation
  }

  /** Track one dispatch transaction through delivery admission or contained failure. */
  private trackDispatch<T>(operation: Promise<T>): Promise<T> {
    this.inFlightDispatches.add(operation)
    void operation.then(() => {
      this.inFlightDispatches.delete(operation)
    }, () => {
      this.inFlightDispatches.delete(operation)
    })
    return operation
  }

  /** Attempt one queued message admitted before the service lifecycle cutoff. */
  private async tryDispatchAdmitted(
    root: Agent,
    message: TeamMessageSnapshot,
    signal: AbortSignal,
  ): Promise<boolean> {
    return await this.serializeDispatch(message, () => this.dispatchThrough(root, message, signal))
  }

  /** Serialize delivery admission for one durable target in queued order. */
  private async serializeDispatch(
    message: TeamMessageSnapshot,
    operation: () => Promise<boolean>,
  ): Promise<boolean> {
    const targetId = message.targetId
    const prior = this.dispatchTails.get(targetId) ?? Promise.resolve()
    /* v8 ignore next -- dispatch tails absorb rejection, so the recovery callback is a fail-safe backstop. */
    const run = prior.then(operation, operation)
    /* v8 ignore next -- dispatchOnce contains delivery failures and serializeDispatch itself does not throw. */
    const tail = run.then(() => undefined, () => undefined)
    this.dispatchTails.set(targetId, tail)
    try {
      return await run
    } finally {
      if (this.dispatchTails.get(targetId) === tail) this.dispatchTails.delete(targetId)
    }
  }

  /** Deliver every pending target message through `message` in durable queue order. */
  private async dispatchThrough(
    root: Agent,
    message: TeamMessageSnapshot,
    signal: AbortSignal,
  ): Promise<boolean> {
    const state = this.journal.state(root)
    const pending = state.messages.filter(candidate =>
      candidate.targetId === message.targetId && !state.delivered.includes(candidate.id))
    const requested = pending.findIndex(candidate => candidate.id === message.id)
    if (requested < 0) return state.delivered.includes(message.id)
    for (const candidate of pending.slice(0, requested + 1)) {
      const ownsInFlight = !this.inFlightMessages.has(candidate.id)
      if (ownsInFlight) this.inFlightMessages.add(candidate.id)
      try {
        if (!await this.dispatchOnce(root, candidate, signal)) return false
      } finally {
        if (ownsInFlight) this.inFlightMessages.delete(candidate.id)
      }
    }
    return true
  }

  /** Attempt one queued delivery after target-local ordering admits it. */
  private async dispatchOnce(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean> {
    try {
      const target = message.targetId === root.id ? root : this.ctx.agents.get(message.targetId)
      if (target !== undefined && this.targetRecorded(target.session, message.id)) {
        return await this.checkpointDelivered(root, target.session, message.id)
      }
      const source = {
        kind: 'team-message' as const,
        teamId: TeamId(root.id),
        messageId: message.id,
        senderId: message.senderId,
        senderName: message.senderName,
      }
      const content = this.deliveryContent(message)
      if (message.targetId === root.id) {
        const input = createUserMessage({ content, source })
        root.steer(input)
        return await this.checkpointDelivered(root, root.session, message.id)
      }
      if (target === undefined) {
        const recorded = await this.persistedTargetRecorded(message.targetId, message.id, signal)
        if (recorded === undefined) return false
        if (recorded) {
          await this.markDelivered(root, message.id, message.targetId)
          return true
        }
      }
      await steerHostSubagentPrompt(this.ctx.subagents, root, message.targetId, content, source, signal)
      return target === undefined
        ? true
        : await this.checkpointDelivered(root, target.session, message.id)
    } catch (error: unknown) {
      this.ctx.logger.warn(`team message "${message.id}" remains queued: ${errorMessage(error)}`)
      return false
    }
  }

  /** Flush one live target receipt before the Lead records its delivered edge. */
  private async checkpointDelivered(
    root: Agent,
    target: Session,
    messageId: TeamMessageId,
  ): Promise<boolean> {
    await this.ctx.sessions.flush(target)
    if (!this.targetRecorded(target, messageId)) return false
    await this.markDelivered(root, messageId, target.id)
    return true
  }

  /** Record delivery unless the acknowledgement already exists. */
  private async markDelivered(root: Agent, messageId: TeamMessageId, targetId: SessionId): Promise<void> {
    await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      if (state.delivered.includes(messageId)) return
      const queued = state.messages.find(message => message.id === messageId)
      if (queued === undefined || queued.targetId !== targetId) return
      await this.journal.appendAndFlush(root, 'team/message/delivered', {
        version: 2,
        teamId: TeamId(root.id),
        messageId,
        targetId,
      })
    })
  }

  /** Whether a target Session already contains the durable message identity. */
  private targetRecorded(session: Session, messageId: TeamMessageId): boolean {
    const suffix = session.snapshotEvents(session.inheritedEventCount)
    return messageAccepted(suffix, message => message.source.kind === 'team-message'
      && message.source.messageId === messageId)
  }

  /** Frame peer content with stable sender and message identity for the receiving model. */
  private deliveryContent(message: TeamMessageSnapshot): ContentBlock[] {
    return [
      { type: 'text', text: `Team message ${message.id} from ${message.senderName}:` },
      ...structuredClone(message.content),
    ]
  }

  /** Read an inactive target's durable log before cold resume; uncertainty keeps the mailbox queued. */
  private async persistedTargetRecorded(
    targetId: SessionId,
    messageId: TeamMessageId,
    signal: AbortSignal,
  ): Promise<boolean | undefined> {
    try {
      const stored = await readPersistedSession(this.ctx.sessionPersistence, targetId, signal)
      const suffix = stored.events.slice(stored.inheritedEventCount)
      return messageAccepted(suffix, message => message.source.kind === 'team-message'
        && message.source.messageId === messageId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`cannot read Team message target "${targetId}": ${errorMessage(error)}`)
      return undefined
    }
  }
}
