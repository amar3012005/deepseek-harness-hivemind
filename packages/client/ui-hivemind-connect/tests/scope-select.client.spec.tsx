// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ScopeSelect } from '../src/client/ScopeSelect.tsx'

describe('HIVE-MIND read scope control', () => {
  it('uses the native folder mark for the Full scope read union', () => {
    const { container } = render(<ScopeSelect sessionId={'session-1' as never} locked={false} initialScope="full" onSelect={vi.fn()} />)

    expect((screen.getByLabelText('HIVE-MIND read scope') as HTMLSelectElement).value).toBe('full')
    expect(screen.getByText('HIVE-MIND Chat')).toBeTruthy()
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('gets project choices only after Project is selected and submits an opaque project id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ projects: [{
      id: 'b79673b4-4578-4fc2-8144-05056983f4e1', name: 'Authorized project', slug: 'authorized-project',
    }] })))
    vi.stubGlobal('fetch', fetchMock)
    const onSelect = vi.fn()
    render(<ScopeSelect sessionId={'session-1' as never} locked={false} initialScope="full" onSelect={onSelect} />)

    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(screen.getAllByLabelText('HIVE-MIND read scope').at(-1)!, { target: { value: 'project' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/hivemind/projects', { credentials: 'include' }))
    fireEvent.change(screen.getAllByLabelText('Authorized project').at(-1)!, { target: { value: 'b79673b4-4578-4fc2-8144-05056983f4e1' } })
    expect(onSelect).toHaveBeenCalledWith('session-1', 'project', 'b79673b4-4578-4fc2-8144-05056983f4e1')
  })
})
