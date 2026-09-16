import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('HIVE-MIND trajectory shell contract', () => {
  it('keeps the native session rail mounted when Trajectory owns its composer overlay', () => {
    const stylesheet = readFileSync(new URL('../src/client/AppFrame.module.css', import.meta.url), 'utf8')

    expect(stylesheet).toContain('.sessionRailCol')
    expect(stylesheet).not.toContain('.frame:has([data-conversation-composer-overlay]) .sessionRailCol')
  })
})
