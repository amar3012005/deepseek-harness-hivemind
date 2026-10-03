// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { HyperagentWorkbench } from '../src/client/HyperagentWorkbench.tsx'
afterEach(cleanup)
it.each(['runtime-room', 'ravi-room'])('keeps textual Preview at the top in %s', (sessionId) => {
  const props = {
    kind: 'preview', sessionId,
    useTabInfo: () => ({ tab: { navigation: {} } }),
    useEmployeeEvents: (select: (value: unknown) => unknown) => select({ entries: [{ type: 'event', event: {
      type: 'hivemind/generation-created', data: { artifactId: 'saved', path: 'brief.md', title: 'Brief', mediaType: 'text/markdown' },
    } }] }),
    loadImage: vi.fn(), loadPdf: vi.fn(), loadText: vi.fn(), openArtifact: vi.fn(), selectArtifact: vi.fn(), t: (key: string) => key,
  }
  render(<HyperagentWorkbench {...props as unknown as Parameters<typeof HyperagentWorkbench>[0]} />)
  expect(document.querySelector('[data-preview-alignment]')?.getAttribute('data-preview-alignment')).toBe('top')
})
it('centers the visual Preview without changing its receipt', () => {
  const props = {
    kind: 'preview', sessionId: 'ravi-room',
    useTabInfo: () => ({ tab: { navigation: {} } }),
    useEmployeeEvents: (select: (value: unknown) => unknown) => select({ entries: [{ type: 'event', event: {
      type: 'hivemind/generation-created', data: { artifactId: 'saved', path: 'image.png', title: 'Image', mediaType: 'image/png' },
    } }] }),
    loadImage: vi.fn(), loadPdf: vi.fn(), loadText: vi.fn(), openArtifact: vi.fn(), selectArtifact: vi.fn(), t: (key: string) => key,
  }
  render(<HyperagentWorkbench {...props as unknown as Parameters<typeof HyperagentWorkbench>[0]} />)
  expect(document.querySelector('[data-preview-alignment]')?.getAttribute('data-preview-alignment')).toBe('center')
})
