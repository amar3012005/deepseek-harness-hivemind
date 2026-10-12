/** Product adapter for resolving tenant-owned, independent employee Sessions. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionCommandController } from './commands.ts'
import { ApiSessionAgentController } from './agent.ts'

export interface PersistentEmployeeProfile {
  readonly id: string
  readonly name: string
  readonly role: string
}

interface EmployeeRoomPersistence {
  employeeRoomId(key: string): Promise<SessionId>
}

/**
 * Bridges the product's tenant-scoped canonical room identity to native Agent
 * admission. It does not bind a Team member or route messages.
 */
export class PersistentEmployeeRoomResolver {
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(
    private readonly ctx: Context,
    private readonly commands: SessionCommandController,
    private readonly agents: ApiSessionAgentController,
  ) {}

  private async serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(id) ?? Promise.resolve()
    const current = prior.catch(() => undefined).then(operation)
    this.tails.set(id, current)
    try {
      return await current
    } finally {
      if (this.tails.get(id) === current) this.tails.delete(id)
    }
  }

  async resolve(
    key: string,
    profile: PersistentEmployeeProfile,
    signal: AbortSignal,
  ): Promise<Agent> {
    signal.throwIfAborted()
    if (key !== profile.id) throw new Error('agent_message_target_identity_conflict')
    const persistence = this.ctx.sessionPersistence as (typeof this.ctx.sessionPersistence & Partial<EmployeeRoomPersistence>) | undefined
    if (persistence === undefined || typeof persistence.employeeRoomId !== 'function') {
      throw new Error('persistent_employee_room_identity_unavailable')
    }
    const sessionId = await persistence.employeeRoomId(key)
    signal.throwIfAborted()
    return this.serialized(sessionId, async () => {
      signal.throwIfAborted()
      await this.commands.create({ sessionId, agentPreset: 'hivemind-hyperagents' })
      signal.throwIfAborted()
      const agent = this.ctx.agents.get(sessionId)
      if (agent === undefined || agent.session.id !== sessionId) {
        throw new Error('persistent_employee_room_unavailable')
      }
      const session = agent.session
      if (session.header.parentSession !== undefined || session.header.origin === 'subagent') {
        throw new Error('persistent_employee_room_independent_root_required')
      }
      if (this.agents.presetForSession(session) !== 'hivemind-hyperagents') {
        throw new Error('persistent_employee_room_preset_conflict')
      }

      const events = session.snapshotEvents()
      const owner = events.find(event => String(event.type) === 'hivemind/session-owner')?.data as { id?: unknown } | undefined
      if (owner !== undefined && owner.id !== profile.id) {
        throw new Error('agent_message_target_identity_conflict')
      }
      const selectionEvent = events.findLast(event => String(event.type) === 'hivemind/employee-selection')
      const selection = selectionEvent?.data as { id?: unknown } | undefined
      if (selection !== undefined && selection.id !== null && selection.id !== profile.id) {
        throw new Error('agent_message_target_identity_conflict')
      }
      if (owner === undefined && selection?.id !== profile.id) {
        // HIVE owns this event declaration. Keep generic Harness APIs unaware of it.
        Reflect.apply(session.append, session, ['hivemind/employee-selection', profile])
        if (!(await this.ctx.sessions.flush(session))) {
          throw new Error('persistent_employee_room_selection_persistence_required')
        }
      }
      signal.throwIfAborted()
      return agent
    })
  }
}
