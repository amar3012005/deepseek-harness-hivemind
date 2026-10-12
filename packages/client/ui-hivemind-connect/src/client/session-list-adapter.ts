import type { SessionId } from '@deepseek-ai/dsh-session/types'

interface SessionProjectionRead {
  readonly byId: Readonly<Record<string, {
    readonly id: SessionId
    readonly retainedBy: { readonly mainView?: number }
    readonly projectionValues?: { readonly agentPreset?: string | null }
  }>>
  readonly projectionsBySession: Readonly<Record<string, { readonly values: { readonly agentPreset?: string | null } }>>
}

/** Resolve the Session retained by the native main-view lifecycle owner. */
export function mainViewSessionId(state: SessionProjectionRead): SessionId | undefined {
  return Object.values(state.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id
}

/** Read a complete native agent-preset projection, including the list cache. */
export function projectedPreset(state: SessionProjectionRead, id: SessionId | undefined): string | null | undefined {
  if (id === undefined) return undefined
  return state.byId[id]?.projectionValues?.agentPreset ?? state.projectionsBySession[id]?.values.agentPreset
}
