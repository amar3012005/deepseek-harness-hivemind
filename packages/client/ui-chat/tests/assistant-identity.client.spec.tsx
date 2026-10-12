import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantIdentityLayout } from '../src/client/chat/AssistantNodeView.tsx'

it('preserves native message markup when no identity occupant exists', () => {
  expect(renderToStaticMarkup(<AssistantIdentityLayout><p>Answer</p></AssistantIdentityLayout>))
    .toBe('<p>Answer</p>')
})

it('renders supplied identity alongside the answer without replacing content', () => {
  const markup = renderToStaticMarkup(<AssistantIdentityLayout avatar={<span aria-label="Runtime">R</span>}><p>Answer</p></AssistantIdentityLayout>)
  expect(markup).toContain('data-assistant-message')
  expect(markup).toContain('aria-label="Runtime"')
  expect(markup).toContain('<p>Answer</p>')
})
