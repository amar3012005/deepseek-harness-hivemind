// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ScopeSelect } from '../src/client/ScopeSelect.tsx'
import { setupSingulanceHeadline, SingulanceMark } from '../src/client/SingulanceMark.tsx'

afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); vi.unstubAllGlobals() })

/**
 * Stubs `matchMedia` with one live query object, as a browser MediaQueryList is: `matches` is
 * updated in place and `change` listeners are fired by `setPhone`.
 */
function stubViewport(phone: boolean): { setPhone(next: boolean): void; listeners: Set<() => void> } {
  const listeners = new Set<() => void>()
  const query = {
    matches: phone,
    media: '(max-width: 600px)',
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
  }
  vi.stubGlobal('matchMedia', vi.fn(() => query))
  return {
    listeners,
    setPhone(next: boolean) {
      query.matches = next
      for (const listener of listeners) listener()
    },
  }
}

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
  it('phone: greets the viewer by first name and shows the Brain tagline as the line above the composer', () => {
    stubViewport(true)
    const host = document.createElement('div')
    host.setAttribute('data-viewer-first-name', 'Amar')
    document.body.appendChild(host)
    const view = render(<div data-testid="welcome" data-conversation-intro-headline><span /><span><span>Into the Unknown</span><span>Preview</span></span></div>)
    const dispose = setupSingulanceHeadline(() => 'hivemind-chat')
    expect(view.getByText('Hey there, Amar')).toBeTruthy()
    expect(view.getByText('Brain: Let’s remember what matters').style.display).toBe('')
    expect(view.queryByText('Preview')).toBeNull()
    dispose()
    host.remove()
    expect(view.getByText('Into the Unknown')).toBeTruthy()
    expect(view.getByText('Preview').style.display).toBe('')
  })

  it('phone: falls back to a plain "Hey there" greeting when no viewer name is published', () => {
    stubViewport(true)
    const view = render(
      <div data-testid="welcome" data-conversation-intro-headline>
        <span />
        <span><span>Into the Unknown</span><span>Preview</span></span>
      </div>,
    )
    const dispose = setupSingulanceHeadline(() => 'hivemind-chat')
    expect(view.getByText('Hey there')).toBeTruthy()
    dispose()
  })

  it('desktop: keeps the base headline "Brain: Let’s remember what matters" with the badge hidden', () => {
    stubViewport(false)
    const host = document.createElement('div')
    host.setAttribute('data-viewer-first-name', 'Amar')
    document.body.appendChild(host)
    const view = render(<div data-testid="welcome" data-conversation-intro-headline><span /><span><span>Into the Unknown</span><span>Preview</span></span></div>)
    const dispose = setupSingulanceHeadline(() => 'hivemind-chat')
    expect(view.getByText('Brain: Let’s remember what matters')).toBeTruthy()
    expect(view.queryByText('Hey there, Amar')).toBeNull()
    expect(view.getByText('Let’s remember what matters').style.display).toBe('none')
    dispose()
    host.remove()
    expect(view.getByText('Into the Unknown')).toBeTruthy()
    expect(view.getByText('Preview').style.display).toBe('')
  })

  it('re-applies the headline when the viewport crosses the phone breakpoint', () => {
    const viewport = stubViewport(false)
    const view = render(<div data-testid="welcome" data-conversation-intro-headline><span /><span><span>Into the Unknown</span><span>Preview</span></span></div>)
    const dispose = setupSingulanceHeadline(() => 'hivemind-chat')
    expect(view.getByText('Brain: Let’s remember what matters')).toBeTruthy()
    expect(viewport.listeners.size).toBe(1)
    viewport.setPhone(true)
    expect(view.getByText('Hey there')).toBeTruthy()
    expect(view.getByText('Brain: Let’s remember what matters').style.display).toBe('')
    viewport.setPhone(false)
    expect(view.getByText('Brain: Let’s remember what matters')).toBeTruthy()
    expect(view.getByText('Let’s remember what matters').style.display).toBe('none')
    dispose()
    expect(viewport.listeners.size).toBe(0)
  })
  it('preserves the introductory headline outside a branded HIVE mode', () => {
    const view = render(<div>
      <div data-testid="headline" data-conversation-intro-headline><span><span data-hivemind-hero-brand="singulance"><img alt="Runtime" /></span></span><span><span>Beyond Horizon Of Intelligence</span><span>Preview</span></span></div>
    </div>)
    stubViewport(true)
    Object.defineProperty(view.getByText('Beyond Horizon Of Intelligence'), 'getAnimations', { value: () => [] })
    const dispose = setupSingulanceHeadline()
    expect(view.getByTestId('headline').hasAttribute('data-hivemind-hero-headline')).toBe(false)
    expect(view.getByTestId('headline').style.display).toBe('')
    expect(view.getByText('Beyond Horizon Of Intelligence')).toBeTruthy()
    dispose()
    expect(view.getByTestId('headline').hasAttribute('data-hivemind-hero-headline')).toBe(false)
    expect(view.getByTestId('headline').style.display).toBe('')
    expect(view.getByText('Beyond Horizon Of Intelligence')).toBeTruthy()
  })

  it.each([['hivemind-hq', 'RUNTIME : Lets Shape your company together'], ['hivemind-hyperagents', 'Hyperagents : Lets do the real work.']])('shows the first-entry heading for %s', (preset, text) => {
    const view = render(<div data-testid="welcome" data-conversation-intro-headline><span /><span><span>Old title</span><span>Preview</span></span></div>)
    const dispose = setupSingulanceHeadline(() => preset)
    expect(view.getByText(text)).toBeTruthy()
    expect(view.getByTestId('welcome').style.display).toBe('')
    dispose()
    expect(view.getByText('Old title')).toBeTruthy()
  })

  it('renders the hero mark at the doubled 48px size', () => {
    // The component default is part of the visual contract; inspect its
    // rendered SVG rather than duplicating the sizing rule in test setup.
    const rendered = render(<SingulanceMark />)
    expect(rendered.container.querySelector('svg')?.getAttribute('width')).toBe('48')
    expect(rendered.container.querySelector('svg')?.getAttribute('height')).toBe('48')
  })
})

it.each(['/hivemind/app/employee/harness', '/hivemind/app/employee/harness/session/saved'])('keeps scope out of the compact agent composer at %s', (path) => {
  window.history.replaceState({}, '', path)
  const view = render(<ScopeSelect sessionId={'session-1' as never} initialScope="full" onSelect={vi.fn()} />)
  expect(view.queryByLabelText('HIVE-MIND read scope')).toBeNull()
})
