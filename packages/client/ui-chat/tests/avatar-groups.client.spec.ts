import { expect, it } from 'vitest'
import { avatarGroupEnds } from '../src/client/chat/avatar-groups.ts'

it('moves the avatar to the newest bubble without crossing a sender or human boundary', () => {
  const items = [{ key: 'a', speaker: 'runtime' }, { key: 'tool' }, { key: 'b', speaker: 'runtime' }]
  expect([...avatarGroupEnds(items)]).toEqual(['b'])
  expect([...avatarGroupEnds([...items, { key: 'c', speaker: 'ravi' }])]).toEqual(['b', 'c'])
  expect([...avatarGroupEnds([...items, { key: 'human', boundary: true }, { key: 'd', speaker: 'runtime' }])])
    .toEqual(['b', 'd'])
})
