/** Filesystem-free workspace service for the embedded multi-tenant HIVE chat profile. */
import { Service, type Context } from '@deepseek-ai/cordis'

/**
 * Satisfies native session-controller composition without indexing tenant
 * sessions at process startup or publishing any host directory capability.
 * HIVE chat sessions are intentionally unattached to a filesystem workspace.
 */
export default class HivemindVirtualWorkspaceRegistry extends Service {
  constructor(ctx: Context) { super(ctx, 'workspaceRegistry') }

  /** HIVE public chat never resolves browser-provided workspace identifiers. */
  get(_id: unknown): undefined { return undefined }

  /** HIVE public chat has no filesystem workspaces to enumerate or inherit. */
  list(): readonly never[] { return [] }
}
