// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ScopeSelect } from '../src/client/ScopeSelect.tsx'

describe('HIVE-MIND read scope control', () => {
  it('gets project choices only after Project is selected and submits an opaque project id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ projects: [{
      id: 'b79673b4-4578-4fc2-8144-05056983f4e1', name: 'Authorized project', slug: 'authorized-project',
    }] })))
    vi.stubGlobal('fetch', fetchMock)
    const onSelect = vi.fn()
    render(<ScopeSelect sessionId={'session-1' as never} locked={false} initialScope="full" onSelect={onSelect} />)

    expect(screen.getByRole('option', { name: 'Choose your workspace' })).toBeTruthy()
    expect(screen.getByLabelText('HIVE-MIND read scope').parentElement?.querySelector('svg')).not.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('HIVE-MIND read scope'), { target: { value: 'project' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/hivemind/projects', { credentials: 'include' }))
    fireEvent.change(screen.getByLabelText('Authorized project'), { target: { value: 'b79673b4-4578-4fc2-8144-05056983f4e1' } })
    expect(onSelect).toHaveBeenCalledWith('session-1', 'project', 'b79673b4-4578-4fc2-8144-05056983f4e1')
  })
})
