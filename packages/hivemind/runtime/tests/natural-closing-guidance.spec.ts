import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it.each(['hivemind-hq', 'hivemind-hyperagents'])('keeps %s closing replies natural without changing native persistence', (name) => {
  const path = `${process.cwd()}/packages/preset/agent-presets/presets/${name}/agent.cordis.yml`
  const text = readFileSync(path, 'utf8')
  expect(text).toContain("in the user's language")
  expect(text).toContain('Perform and verify those')
  expect(text).toContain('without narrating their mechanics')
  expect(text).toContain('do not repeat the last handoff or rest statement')
  expect(text).toContain('Do not append routine')
})
