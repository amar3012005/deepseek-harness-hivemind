import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const webPatch = readFileSync(new URL('../../web-app/cordis.patch.yml', import.meta.url), 'utf8')
const connectPackage = JSON.parse(readFileSync(
  new URL('../../../client/ui-hivemind-connect/package.json', import.meta.url),
  'utf8',
)) as { dsh: { client: { inject: string[] } } }

describe('hivemind-web native renderer parity', () => {
  it('omits developer prompt contributions without replacing native tool guidance', () => {
    expect(patch).toContain('includeHarnessIdentity: false')
    expect(patch).toContain('includeRuntimeContext: false')
    expect(patch).toContain('surfaceContext: false')
    expect(patch).not.toContain('complete: true')
  })
  it('keeps prompt events but hides their developer-facing transcript rows', () => {
    expect(patch).toMatch(/- id: ui-chat\n  config:\n    showSystemPrompts: false/)
  })
  it('does not disable native conversation and rendering plugins', () => {
    const nativeSurfaces = [
      'ui-layout', 'ui-renderer', 'ui-session', 'ui-sidebar', 'ui-conversation',
      'ui-chat', 'ui-attachment', 'ui-tool', 'ui-workspace', 'ui-input-trigger',
      'ui-commands', 'ui-skill', 'ui-subagent', 'ui-reference', 'ui-jobs',
      'ui-goal', 'ui-message-feedback', 'ui-model-selection', 'ui-agent-preset',
      'ui-plan', 'ui-user-questions', 'ui-trajectory', 'ui-approval',
      'ui-workflow-run',
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

  it('loads the HIVE connection answerer before the generic question fallback', () => {
    expect(connectPackage.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-ui-conversation')
    expect(connectPackage.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-ui-tool')
  })

  it('does not strand a native session behind the former fifteen-minute grant', () => {
    expect(patch).toContain('sessionMaxAgeSeconds: 86400')
    expect(patch).not.toContain('sessionMaxAgeSeconds: 900')
  })

  it('turns off optional OpenRouter reasoning for the default HIVE model', () => {
    expect(patch).toContain('off: none')
    expect(patch).toContain('reasoning: off')
    expect(patch).toContain('thinkingFormat: openrouter')
    expect(patch).not.toContain('reasoningEffort: off')
    expect(patch).toContain('model: openrouter/deepseek/deepseek-v4-flash-0731')
  })

})
