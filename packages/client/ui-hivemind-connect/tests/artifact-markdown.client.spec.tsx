// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { TextReceipt } from '../src/client/HyperagentWorkbench.tsx'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
afterEach(cleanup)
const file = { attachmentId: 'saved-file', name: 'brief.md', bytes: 705 } as FileAttachmentRef
it('renders returned receipt Markdown contents using the native primitive', async () => {
  const loadText = vi.fn(async () => '# Café Brief\n\nVegetarian **seasonal** toast.\n\n[Source](https://example.org)')
  render(<TextReceipt file={file} loadText={loadText} t={key => key} />)
  expect(loadText).toHaveBeenCalledWith(file)
  await waitFor(() => expect(document.querySelector('[data-artifact-markdown] h1')?.textContent).toBe('Café Brief'))
  expect(document.querySelector('[data-artifact-markdown] strong')?.textContent).toBe('seasonal')
  expect(document.querySelector('[data-artifact-markdown] a')?.getAttribute('href')).toBe('https://example.org')
})
it('shows a read failure rather than inventing document contents', async () => {
  render(<TextReceipt file={file} loadText={async () => { throw new Error('denied') }} t={key => key} />)
  await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('workbench.textUnavailable'))
  expect(document.querySelector('[data-artifact-markdown]')).toBeNull()
})
