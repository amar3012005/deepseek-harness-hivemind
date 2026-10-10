import { expect, it } from 'vitest'
import { briefAgentMessage } from '../src/client/chat/brief-agent-message.ts'
it('uses explicit display copy without summarizing or replacing complete text', () => {
  expect(briefAgentMessage({ summary: ' Review is still pending. ', text: 'Long technical evidence.\n'.repeat(20) })).toBe('Review is still pending.')
})
it.each([undefined, 4, '', ' ', 'a\nb', 'a\rb', 'x'.repeat(241)])('rejects unsupported brief display text (%s)', (text) => {
  expect(briefAgentMessage({ text })).toBeUndefined()
  expect(briefAgentMessage({ summary: text })).toBeUndefined()
})
it.each(['', ' ', 'bad\nsummary', 'x'.repeat(241)])('retains short original prose when summary is invalid (%s)', (summary) => {
  expect(briefAgentMessage({ summary, text: 'Please review this.' })).toBe('Please review this.')
})
it('removes only the known sender prefix and rejects an empty message after it', () => {
  expect(briefAgentMessage({ senderName: 'Ravi', text: 'Ravi: Please review this.' })).toBe('Please review this.')
  expect(briefAgentMessage({ senderName: 'Ravi', text: 'Ravi:' })).toBeUndefined()
  expect(briefAgentMessage({ senderName: 'Other', text: 'Ravi: Please review this.' })).toBe('Ravi: Please review this.')
  expect(briefAgentMessage({ senderName: 1, text: 'Please review this.' })).toBe('Please review this.')
})
