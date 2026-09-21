// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ScopeSelect } from '../src/client/ScopeSelect.tsx'
import { setupSingulanceHeadline, SingulanceMark } from '../src/client/SingulanceMark.tsx'

describe('HIVE-MIND read scope control', () => {
  it('uses the native folder mark for the Full scope read union', () => {
    const { container } = render(<ScopeSelect sessionId={'session-1' as never} locked={false} initialScope="full" onSelect={vi.fn()} />)

    expect((screen.getByLabelText('HIVE-MIND read scope') as HTMLSelectElement).value).toBe('full')
    expect(screen.queryByText('HIVE-MIND Chat')).toBeNull()
    expect(container.querySelectorAll('svg')).toHaveLength(1)
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

describe('HIVE-MIND hero branding', () => {
  it('replaces the oversized headline with a left-alignable Brain label', () => {
    const view = render(<div>
      <div data-testid="headline"><span><svg data-hivemind-hero-brand="singulance" /></span><span><span>Beyond Horizon Of Intelligence</span><span>Preview</span></span></div>
    </div>)
    const dispose = setupSingulanceHeadline()
    expect(view.getByTestId('headline').hasAttribute('data-hivemind-hero-headline')).toBe(true)
    expect(view.getByText('BRAIN · Remember what matters.')).toBeTruthy()
    dispose()
    expect(view.getByTestId('headline').hasAttribute('data-hivemind-hero-headline')).toBe(false)
    expect(view.getByText('Beyond Horizon Of Intelligence')).toBeTruthy()
  })

  it('renders the hero mark at the doubled 48px size', () => {
    // The component default is part of the visual contract; inspect its
    // rendered SVG rather than duplicating the sizing rule in test setup.
    const rendered = render(<SingulanceMark />)
    expect(rendered.container.querySelector('svg')?.getAttribute('width')).toBe('48')
    expect(rendered.container.querySelector('svg')?.getAttribute('height')).toBe('48')
  })
})
