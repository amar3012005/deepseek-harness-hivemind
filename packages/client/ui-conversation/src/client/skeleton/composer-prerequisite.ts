/**
 * Resolve the inert posture for the resident Composer without changing its
 * mounted editor tree.
 * @param sessionId - currently bound Session, when one exists.
 * @param hero - whether this is the blank-session hero state.
 * @param workspaceRequired - scoped Workspace prerequisite policy.
 * @param workspaceTitle - visible Workspace chip title, when resolved.
 * @returns whether the composer must wait for a Session or Workspace choice.
 */
export function composerIsInert(
  sessionId: string | undefined,
  hero: boolean,
  workspaceRequired: boolean,
  workspaceTitle: string | undefined,
): boolean {
  return sessionId === undefined || (workspaceRequired && hero && workspaceTitle === undefined)
}
