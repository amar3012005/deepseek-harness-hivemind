/** Full access reuses native permission presets; no parallel permission state. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { admittedEmployeeWork } from './employee-work-origin.ts'
import { authenticatedRoot, allowsEmployeeWork } from './employee-room.ts'

interface Presets {
  current(session: Agent['session']): string
  set(session: Agent['session'], name: string): void
}
function presets(ctx: Context): Presets {
  const value = Reflect.get(ctx, 'permissionPresets') as Presets | undefined
  if (!value) throw Error('runtime_permission_presets_unavailable')
  return value
}
export function fullAccessState(ctx: Context, agent: Agent) {
  return {
    enabled: presets(ctx).current(agent.session) === 'danger-full-access',
    revision: agent.session.ownEvents()
      .filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type))
      .at(-1)?.seq ?? 0,
  }
}
export async function validateFullAccessAdministrator(ctx: Context, agent: Agent, signal: AbortSignal): Promise<void> {
  const scope = ctx.hivemindExecutionScope.require()
  // Native Remote also admits request principals without a message Actor; the
  // fresh Core persistence check below remains mandatory for that path.
  if (scope.authenticatedActor && (!['admin', 'owner'].includes(scope.authenticatedActor.role)
    || scope.authenticatedActor.orgId !== scope.orgId || scope.authenticatedActor.userId !== scope.userId)) throw Error('runtime_administrator_required')
  const persistence = ctx.sessionPersistence as typeof ctx.sessionPersistence & {
    validateAdministratorRoom?: (id: SessionId) => Promise<void>
  }
  if (!persistence.validateAdministratorRoom) throw Error('runtime_administrator_validation_unavailable')
  await persistence.validateAdministratorRoom(agent.id)
  if (await authenticatedRoot(ctx, agent.id, signal) !== agent) throw Error('runtime_scope_changed')
}
export async function setFullAccess(ctx: Context, agent: Agent, request: { enabled: boolean; expectedRevision: number }) {
  if (typeof request.enabled !== 'boolean' || !Number.isSafeInteger(request.expectedRevision)) {
    throw Error('invalid_runtime_permission_selection')
  }
  return agent.runMaintenance(async (signal) => {
    await validateFullAccessAdministrator(ctx, agent, signal)
    const current = fullAccessState(ctx, agent)
    if (current.revision !== request.expectedRevision) return { ok: false as const, current }
    const previous = presets(ctx).current(agent.session)
    presets(ctx).set(agent.session, request.enabled ? 'danger-full-access' : 'workspace-write')
    try {
      if (!await ctx.sessions.flush(agent.session)) throw Error('runtime_permission_not_persisted')
    } catch {
      // Do not leave dispatch using an unacknowledged permission escalation.
      presets(ctx).set(agent.session, previous)
      try { await ctx.sessions.flush(agent.session) } catch { /* Keep the safer in-memory preset; the caller sees failure. */ }
      throw Error('runtime_permission_not_persisted')
    }
    return { ok: true as const, current: fullAccessState(ctx, agent) }
  })
}
/** Recheck the actual Runtime and task on each dispatch; never mutate employee presets. */
export async function delegatedFullAccess(ctx: Context, agent: Agent, signal: AbortSignal): Promise<boolean> {
  const origin = admittedEmployeeWork(agent)
  if (!origin) return false
  const root = await authenticatedRoot(ctx, origin.rootId, signal)
  if (!fullAccessState(ctx, root).enabled) return false
  await validateFullAccessAdministrator(ctx, root, signal)
  const admitted = await allowsEmployeeWork(ctx, agent, origin, signal)
  return admitted && fullAccessState(ctx, root).enabled
}
