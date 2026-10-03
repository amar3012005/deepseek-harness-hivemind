// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { ArtifactPreview } from '../src/client/OperatingRun.tsx'
vi.mock('../src/client/download.ts', () => ({ fileArtifactBlob: () => ({ text: async () => '# Café brief\n\n**Vegetarian** toast.' }), saveArtifact: vi.fn() }))
afterEach(cleanup)
it.each(['text/markdown', 'text/plain'])('uses native Markdown only for Markdown files (%s)', async (mediaType) => {
  const file = { name: mediaType === 'text/markdown' ? 'brief.md' : 'brief.txt', attachmentId: 'saved', bytes: 705 }
  const props = {
    useTabInfo: () => ({ tab: { navigation: { params: { artifact: { title: 'Saved brief', mediaType, file, path: file.name } } } } }),
    read: async () => ({ ok: true, value: { attachment: file, data: 'fixture' } }),
    t: (key: string) => key,
  }
  render(<ArtifactPreview {...props as unknown as Parameters<typeof ArtifactPreview>[0]} />)
  expect(document.querySelector('[data-preview-alignment]')?.getAttribute('data-preview-alignment')).toBe('top')
  if (mediaType === 'text/markdown') {
    await waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('Café brief'))
    expect(document.querySelector('strong')?.textContent).toBe('Vegetarian')
    expect(document.querySelector('pre')).toBeNull()
  } else {
    await waitFor(() => expect(document.querySelector('pre')?.textContent).toContain('# Café brief'))
    expect(document.querySelector('h1')).toBeNull()
  }
})
