import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const webPatch = readFileSync(new URL('../../web-app/cordis.patch.yml', import.meta.url), 'utf8')

describe('hivemind-web native renderer parity', () => {
  it('does not disable native conversation and rendering plugins', () => {
    const nativeSurfaces = [
      'ui-layout', 'ui-renderer', 'ui-session', 'ui-sidebar', 'ui-conversation',
      'ui-chat', 'ui-attachment', 'ui-tool', 'ui-workspace', 'ui-input-trigger',
      'ui-commands', 'ui-skill', 'ui-subagent', 'ui-reference', 'ui-jobs',
      'ui-goal', 'ui-message-feedback', 'ui-model-selection', 'ui-agent-preset',
      'ui-plan', 'ui-user-questions', 'ui-trajectory',
    ]
    for (const id of nativeSurfaces) {
      expect(patch).not.toMatch(new RegExp(`- id: ${id}\\n  disabled: true`))
    }
  })

  it('keeps HIVE runtime, persistence, and admission additive', () => {
    expect(webPatch).toContain("name: '@deepseek-ai/dsh-client-ui-hivemind-connect'")
    expect(webPatch.indexOf('id: ui-hivemind-connect')).toBeLessThan(webPatch.indexOf('id: modules'))
    expect(patch).toContain("name: '@deepseek-ai/dsh-hivemind-execution-scope'")
    expect(patch).toContain("name: '@deepseek-ai/dsh-session-persistence-postgres'")
    expect(patch).toContain("name: '@deepseek-ai/dsh-hivemind-web-runner'")
  })

  it('does not strand a native session behind the former fifteen-minute grant', () => {
    expect(patch).toContain('sessionMaxAgeSeconds: 86400')
    expect(patch).not.toContain('sessionMaxAgeSeconds: 900')
  })
})
