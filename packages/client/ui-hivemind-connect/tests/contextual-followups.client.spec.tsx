import { expect, it } from 'vitest'
import { parseContextualFollowUps } from '../src/client/ContextualFollowUps.tsx'

it('retains bounded suggestions from the completed native turn', () => {
  expect(parseContextualFollowUps('Done. <!-- hivemind-follow-ups: [" Review draft ", "Continue research"] -->'))
    .toEqual(['Review draft', 'Continue research'])
})

it('renders no suggestions for absent or malformed metadata', () => {
  for (const text of ['Done.', '<!-- hivemind-follow-ups: [broken] -->', '<!-- hivemind-follow-ups: [1, "x"] -->']) {
    expect(parseContextualFollowUps(text)).toBeNull()
  }
})

it('limits suggestion count and ignores oversized prompts', () => {
  const prompts = ['a'.repeat(141), 'First', 'Second', 'Third', 'Fourth', 'Fifth']
  expect(parseContextualFollowUps(`<!-- hivemind-follow-ups: ${JSON.stringify(prompts)} -->`))
    .toEqual(['First', 'Second', 'Third', 'Fourth'])
})
