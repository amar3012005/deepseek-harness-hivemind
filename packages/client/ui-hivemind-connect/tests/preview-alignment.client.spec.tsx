// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
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

it('fills document viewports from the native pane geometry without scaling', () => {
  const css = readFileSync(`${process.cwd()}/packages/client/ui-hivemind-connect/src/client/HyperagentEmployee.module.css`, 'utf8')
  expect(css).toContain('.workbench[data-preview-fill] > article')
  expect(css).toContain('flex: 1; width: 100%; height: 100%; min-height: 0; margin: 0; border: 0')
  const producer = readFileSync(`${process.cwd()}/packages/client/ui-hivemind-operating-run/src/client/OperatingRun.module.css`, 'utf8')
  expect(producer).toContain('.artifactPreviewBody[data-preview-fill] iframe')
  expect(producer).toContain('flex: 1; width: 100%; height: 100%; min-height: 0;')
})
