import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('HIVE-MIND trajectory shell contract', () => {
  it('keeps the native session rail mounted when Trajectory owns its composer overlay', () => {
    const stylesheet = readFileSync(new URL('../src/client/AppFrame.module.css', import.meta.url), 'utf8')

    expect(stylesheet).toContain('.sessionRailCol')
    expect(stylesheet).not.toContain('.frame:has([data-conversation-composer-overlay]) .sessionRailCol')
  })
})


describe('employee mobile grid tracks', () => {
  it('places the embedded conversation in the real first track, never a zero-width placeholder', () => {
    const stylesheet = readFileSync(new URL('../src/client/AppFrame.module.css', import.meta.url), 'utf8')
    expect(stylesheet).toContain('.frame:has(:global([data-native-chat])) { grid-template-columns: minmax(0, 1fr) 0 !important; }')
    expect(stylesheet).toContain('.frame:has(:global([data-native-chat])) .centerCol { grid-column: 1 !important; }')
    expect(stylesheet).toContain('.frame:has(:global([data-native-chat])) .rightbarCol { grid-column: 2; }')
    expect(stylesheet).not.toContain('grid-template-columns: 0 minmax(0, 1fr) 0 !important')
  })
})
