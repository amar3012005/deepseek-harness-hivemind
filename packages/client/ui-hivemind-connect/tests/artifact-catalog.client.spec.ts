import { expect, it, vi } from 'vitest'
import { loadArtifactCatalog } from '../src/client/artifact-catalog.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
const rooms = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `room-${i}` as SessionId, title: `Room ${i}` }))
const artifact = { id: 'same', title: 'Work', mediaType: 'text/html', path: 'work.html', file: undefined, preview: undefined }
it('starts four room reads, publishes tiles before slow rooms finish, and bounds concurrency', async () => {
  let active = 0; let peak = 0
  let release!: () => void
  const slow = new Promise<void>((resolve) => { release = resolve })
  const progress = vi.fn<(result: { artifacts: unknown[]; incomplete: boolean }) => void>()
  const page = vi.fn(async (room: { id: SessionId }) => {
    active++; peak = Math.max(peak, active)
    if (room.id === 'room-0') await slow
    active--
    return { artifacts: [artifact], hasMore: false }
  })
  const pending = loadArtifactCatalog({ rooms: rooms(6), signal: new AbortController().signal, page, progress })
  await vi.waitFor(() => { expect(progress).toHaveBeenCalled() })
  expect(page).toHaveBeenCalledTimes(4)
  expect(progress.mock.calls[0]?.[0].artifacts.length).toBeGreaterThan(0)
  release()
  const result = await pending
  expect(peak).toBeGreaterThan(1)
  expect(peak).toBeLessThanOrEqual(4)
  expect(result.artifacts).toHaveLength(6)
})
it('visits all latest pages before older history and retains pinned cursor/newest receipt', async () => {
  const page = vi.fn(async (_room: { id: SessionId }, before?: number) => ({ artifacts: [{ ...artifact, title: before ? 'Old' : 'New' }], hasMore: before === undefined, cursor: 20, beforeSeq: before ? 1 : 10 }))
  const result = await loadArtifactCatalog({ rooms: rooms(5), signal: new AbortController().signal, page, progress: () => {} })
  expect(page.mock.calls.slice(0, 5).map(call => call[1])).toEqual([undefined, undefined, undefined, undefined, undefined])
  expect(page.mock.calls[5]?.slice(1)).toEqual([10, 20])
  expect(result.artifacts.every(item => item.title === 'New')).toBe(true)
})
it('caps request budget at 200 and marks unfinished history', async () => {
  const page = vi.fn(async (_room: { id: SessionId }, before?: number) => ({
    artifacts: [], hasMore: true, cursor: 100, beforeSeq: (before ?? 100) - 1,
  }))
  const result = await loadArtifactCatalog({ rooms: rooms(100), signal: new AbortController().signal, page, progress: () => {} })
  expect(page).toHaveBeenCalledTimes(200)
  expect(result.incomplete).toBe(true)
})
it('keeps other room results when one fails, and stops nonadvancing cursors', async () => {
  const result = await loadArtifactCatalog({ rooms: rooms(2), signal: new AbortController().signal, progress: () => {},
    page: async (room) => {
      if (room.id === 'room-0') throw new Error('Unavailable')
      return { artifacts: [artifact], hasMore: true, cursor: 10, beforeSeq: 5 }
    } })
  expect(result.artifacts).toHaveLength(1)
  expect(result.incomplete).toBe(true)
})
it('does not publish or schedule reads after cancellation', async () => {
  const abort = new AbortController(); const progress = vi.fn<(result: { artifacts: unknown[]; incomplete: boolean }) => void>()
  const page = vi.fn(async () => { abort.abort(); return { artifacts: [artifact], hasMore: true, cursor: 10, beforeSeq: 5 } })
  await expect(loadArtifactCatalog({ rooms: rooms(8), signal: abort.signal, page, progress })).rejects.toThrow()
  expect(progress).not.toHaveBeenCalled()
  expect(page.mock.calls.length).toBeLessThanOrEqual(4)
})
