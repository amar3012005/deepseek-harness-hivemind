// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ReceiptImage } from '../src/client/HyperagentWorkbench.tsx'
afterEach(cleanup)
const attachment = { attachmentId: 'sha256:image', mimeType: 'image/png', bytes: 10, width: 10, height: 10 } as never
it('reserves image space while bytes load, then shows the actual image', async () => {
  const load = vi.fn().mockResolvedValue('blob:actual-receipt')
  const view = render(<ReceiptImage attachment={attachment} loadImage={load} />)
  expect(view.getByRole('status').textContent).toBe('Loading image preview…')
  expect((await view.findByRole('img')).getAttribute('src')).toBe('blob:actual-receipt')
  expect(view.queryByRole('status')).toBeNull()
})
it('reports failure rather than leaving an empty metadata-only preview', async () => {
  const view = render(<ReceiptImage attachment={attachment} loadImage={vi.fn().mockRejectedValue(new Error('denied'))} />)
  expect((await view.findByRole('alert')).textContent).toBe('Image preview could not be loaded.')
  expect(view.queryByRole('status')).toBeNull()
})
