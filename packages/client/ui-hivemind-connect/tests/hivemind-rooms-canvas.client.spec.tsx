// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HivemindRoomsCanvas } from '../src/client/HivemindRoomsCanvas.tsx'

describe('HIVE-MIND Rooms native Hero canvas', () => {
  it('renders decorative workspace cards without exposing a second interactive surface', () => {
    const view = render(<HivemindRoomsCanvas t={key => key} />)

    expect(view.container.querySelector('[data-hivemind-rooms-canvas]')?.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.querySelectorAll('article')).toHaveLength(10)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
