/** Host-side human controls; no model tool can enable HQ autonomy. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { hqMode, type HqModeState } from './mode.ts'
import type { HqModeUpdate, HqModeUpdateResult } from './types.ts'
import type {} from './ownership.ts'
export type { HqModeUpdate, HqModeUpdateResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { hivemindHq: HqControl }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Human-only HQ autonomy switch, checkpointed before acknowledging the control. */
    'hivemind/hq-mode': HqModeState
  }
}

/** Effective native preset including selection after a blank session was created. */
function isHq(agent: Agent): boolean {
  let preset = agent.session.header.agentPreset
  for (const event of agent.session.ownEvents()) if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
  return preset === 'hivemind-hq'
}

/** Native Remote service keeps human authority outside model-callable tools. */
export class HqControl extends TypertRemoteService {
  static inject = ['agents', 'agentTeams', 'sessions', 'sessionPersistence', 'hivemindHqOwnership']
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * Mount control and enforce the persisted switch at native dispatch boundaries.
   * @param ctx - authorized native session and Team services.
   */
  constructor(ctx: Context) {
    super(ctx, 'hivemindHq')
    ctx.effect(() => ctx.agentTeams.guardDispatch((caller) => {
      const member = ctx.agentTeams.tryMembership(caller)
      if (!member || !isHq(member.root)) return
      return hqMode(member.root.session.snapshotEvents()).enabled ? undefined : 'HQ autonomous activity is paused by the human.'
    }))
  }

  /** Exact Remote Agent authority cannot control another or an ordinary employee root. */
  private root(agent: Agent): Agent {
    const member = this.ctx.agentTeams.membership(agent)
    if (member.role !== 'lead' || !isHq(member.root)) throw new Error('hq_human_control_requires_hq_root')
    return member.root
  }

  /**
   * Read the switch from a native authenticated HQ root.
   * @param agent - exact authorized Agent selected by the native Remote resolver.
   * @returns replayed switch, defaulting to paused.
   */
  @Remote('mode')
  mode(agent: Agent): HqModeState {
    return hqMode(this.root(agent).session.snapshotEvents())
  }

  /**
   * Enable or pause HQ through the human Remote boundary, never a model tool.
   * @param agent - exact authorized HQ root.
   * @param request - observed revision and intended mode.
   * @returns committed state or a concurrent-edit conflict.
   */
  @Remote('setMode')
  async setMode(agent: Agent, request: HqModeUpdate): Promise<HqModeUpdateResult> {
    const root = this.root(agent)
    if (typeof request.enabled !== 'boolean' || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new Error('hq_invalid_mode_update')
    const prior = this.tails.get(root.id) ?? Promise.resolve()
    const result = prior.then(async (): Promise<HqModeUpdateResult> => {
      const current = this.mode(root)
      if (current.revision !== request.expectedRevision) return { ok: false, code: 'hq-mode-conflict', current }
      if (request.enabled) {
        if (!await this.ctx.sessions.flush(root.session)) throw new Error('hq_mode_persistence_required')
        await this.ctx.hivemindHqOwnership.claim(root.id)
      }
      const value: HqModeState = { revision: current.revision + 1, enabled: request.enabled, changedAt: Date.now() }
      root.session.append('hivemind/hq-mode', value)
      if (!value.enabled) {
        // Cancellation is immediate. Pending native inbox and task state survive.
        root.cancel({ kind: 'user' }, { keepInbox: true })
        for (const member of this.ctx.agentTeams.listMembers(root)) {
          if (member.role === 'teammate') this.ctx.agents.get(member.id)?.cancel({ kind: 'parent' }, { keepInbox: true })
        }
      }
      if (!await this.ctx.sessions.flush(root.session)) throw new Error('hq_mode_persistence_required')
      return { ok: true, value }
    })
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(root.id, tail)
    try { return await result } finally { if (this.tails.get(root.id) === tail) this.tails.delete(root.id) }
  }
}
export default HqControl
