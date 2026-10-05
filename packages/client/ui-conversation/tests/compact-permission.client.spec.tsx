// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PermissionSelect } from '../src/client/skeleton/PermissionSelect.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); window.history.replaceState({}, '', '/') })
it('keeps native access mode choices behind an icon-only agent composer control', () => {
  window.history.replaceState({}, '', '/hivemind/app/employee/harness/session/test')
  const command = vi.fn(async () => true)
  const view = render(<PermissionSelect value={{ currentValue: 'read-only', options: [
    { value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' },
  ] }} locked={false} command={command} t={makeTranslate(en)} />)
  const button = view.getByRole('button')
  expect(button.textContent).toBe('')
  expect(button.getAttribute('aria-label')).toContain('Read Only')
  fireEvent.click(button)
  fireEvent.click(view.getAllByRole('menuitem')[1]!)
  expect(command).toHaveBeenCalledWith('/permission workspace-write')
})
