import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Artifact } from './HyperagentWorkbench.tsx'
import type { LibraryArtifact } from './ArtifactDashboard.tsx'

interface Room { id: SessionId; title?: string | undefined }
interface Page { artifacts: Artifact[]; hasMore: boolean; cursor?: number | undefined; beforeSeq?: number | undefined }
interface Catalog { artifacts: LibraryArtifact[]; incomplete: boolean }

/** Read-only native paging: four readers, latest page of every room before older history. */
export async function loadArtifactCatalog({ rooms, signal, page, progress }: {
  rooms: Room[]
  signal: AbortSignal
  page: (room: Room, beforeSeq?: number, throughSeq?: number) => Promise<Page>
  progress: (catalog: Catalog) => void
}): Promise<Catalog> {
  const queue = rooms.slice(0, 100).map(room => ({
    room, pages: 0, beforeSeq: undefined as number | undefined, throughSeq: undefined as number | undefined,
  }))
  const artifacts = new Map<string, LibraryArtifact>()
  let incomplete = rooms.length > 100
  let budget = 200
  const snapshot = () => ({ artifacts: [...artifacts.values()], incomplete })
  const batch = async () => {
    while (queue.length && budget > 0) {
      signal.throwIfAborted()
      // Reserve the shared budget synchronously before any request yields.
      const tasks = queue.splice(0, Math.min(4, budget))
      budget -= tasks.length
      await Promise.all(tasks.map(async (task) => {
        signal.throwIfAborted()
        try {
          const result = await page(task.room, task.beforeSeq, task.throughSeq)
          signal.throwIfAborted()
          for (const artifact of result.artifacts) {
            const key = `${task.room.id}:${artifact.id}`
            // Newest page wins; identical IDs in different rooms remain distinct.
            if (!artifacts.has(key)) artifacts.set(key, { ...artifact, sessionId: task.room.id, roomTitle: task.room.title || 'Agent room' })
          }
          task.pages++
          if (result.hasMore) {
            if (task.pages >= 10 || result.beforeSeq === undefined || result.cursor === undefined
              || (task.beforeSeq !== undefined && result.beforeSeq >= task.beforeSeq)) incomplete = true
            else queue.push({ ...task, beforeSeq: result.beforeSeq, throughSeq: task.throughSeq ?? result.cursor })
          }
        } catch {
          signal.throwIfAborted()
          incomplete = true
        }
        if (!signal.aborted) progress(snapshot())
      }))
    }
  }
  await batch()
  signal.throwIfAborted()
  if (queue.length) incomplete = true
  return snapshot()
}
