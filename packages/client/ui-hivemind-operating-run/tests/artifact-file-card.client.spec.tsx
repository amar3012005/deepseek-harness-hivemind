// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ArtifactPanel } from '../src/client/OperatingRun.tsx'
import { saveArtifact } from '../src/client/download.ts'
vi.mock('../src/client/download.ts', () => ({ fileArtifactBlob: () => new Blob(['saved']), saveArtifact: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('keeps full file identity and separate native preview/download actions in the compact card', async () => {
  const name = 'audience-regional-fit-evidence-brief-for-runtime.html'
  const file = { attachmentId: 'saved-file', name, bytes: 5 }
  const openPreview = vi.fn()
  const read = vi.fn().mockResolvedValue({ ok: true, value: { attachment: file, data: 'saved' } })
  const props = { sessionId: 'room', node: { id: 'artifact', location: { kind: 'other' }, data: { file, title: name, mediaType: 'text/html' } }, t: (key: string) => key, read, loadImage: vi.fn(), openPreview, registeredAt: Date.now() }
  const view = render(<ArtifactPanel {...props as unknown as Parameters<typeof ArtifactPanel>[0]} />)
  const preview = view.getByRole('button', { name: /audience-regional-fit.*artifact.preview/ })
  expect(preview.getAttribute('title')).toBe(name)
  fireEvent.click(preview)
  expect(openPreview).toHaveBeenCalledOnce()
  expect(read).not.toHaveBeenCalled()
  const download = view.getByRole('button', { name: `artifact.open: ${name}` })
  fireEvent.click(download)
  await waitFor(() => expect(saveArtifact).toHaveBeenCalledWith(expect.any(Blob), name))
  expect(read).toHaveBeenCalledWith(file.attachmentId)
  expect(openPreview).toHaveBeenCalledOnce()
})
