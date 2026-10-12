import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const webPatch = readFileSync(new URL('../../web-app/cordis.patch.yml', import.meta.url), 'utf8')
const tenantAdmission = readFileSync(new URL('../../../hivemind/web-runner/src/tenant-transport.ts', import.meta.url), 'utf8')
const connectPackage = JSON.parse(readFileSync(
  new URL('../../../client/ui-hivemind-connect/package.json', import.meta.url),
  'utf8',
)) as { dsh: { client: { inject: string[] } } }
const cliPackage = JSON.parse(readFileSync(
  new URL('../../../../apps/cli/package.json', import.meta.url),
  'utf8',
)) as { dependencies?: Record<string, string> }

describe('hivemind-web native renderer parity', () => {
  it('routes native scheduling through the owned PostgreSQL domain', () => {
    expect(patch).toContain('schedule: hivemind-schedule-postgres')
    expect(patch).toContain('inject: [scheduleOwnership]')
    expect(patch).toContain('ownershipRequired: true')
    expect(patch).not.toContain('inject: [scheduleBackend]')
    expect(patch.indexOf('id: hivemind-schedule-postgres')).toBeLessThan(patch.indexOf('    - id: schedule\n'))
  })
  it('allows authenticated chat and company work without changing the default', () => {
    expect(patch).toContain('default: hivemind-chat')
    // The native registry no longer accepts `allowed`. Hosted admission owns
    // this fence, with dispatch-level negative cases in tenant-transport tests.
    expect(tenantAdmission).toContain("new Set(['hivemind-chat', 'hivemind-hyperagents', 'hivemind-hq'])")
    expect(tenantAdmission).toContain("endpoint === 'session/create' || endpoint === 'agentPresets/select'")
    expect(patch).not.toContain('allowed: [')
  })

  it('omits developer prompt contributions without replacing native tool guidance', () => {
    expect(patch).toContain('includeHarnessIdentity: false')
    expect(patch).toContain('includeRuntimeContext: false')
    expect(patch).toContain('surfaceContext: false')
    expect(patch).not.toContain('complete: true')
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
    // The HIVE bundle must resolve from the same install anchor as native Web
    // plugins; a profile-private copy splits identity-bearing scope/tool modules.
    expect(cliPackage.dependencies?.['@deepseek-ai/dsh-hivemind-web-app']).toBe('workspace:^')
    expect(patch).toContain("name: '@deepseek-ai/dsh-client-ui-hivemind-connect'")
    expect(webPatch).not.toContain("name: '@deepseek-ai/dsh-client-ui-hivemind-connect'")
    expect(patch).toContain("name: '@deepseek-ai/dsh-hivemind-execution-scope'")
    expect(patch).toContain("name: '@deepseek-ai/dsh-session-persistence-postgres'")
    expect(patch).toContain("name: '@deepseek-ai/dsh-hivemind-web-runner'")
  })

  it('declares native conversation and layout owners for HIVE composer slots', () => {
    expect(connectPackage.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-conversation')
    expect(connectPackage.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(connectPackage.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-ui-tool')
  })

  it.each(['hivemind-hq', 'hivemind-hyperagents'])('%s isolates its checkpoint services', (preset) => {
    const definition = readFileSync(new URL(`../presets/${preset}.patch.yml`, import.meta.url), 'utf8')
    expect(definition).toContain('hivemindMemoryApproval: true')
    if (preset === 'hivemind-hq') expect(definition).toContain('hivemindRuntimeApproval: true')
  })

  it('does not strand a native session behind the former fifteen-minute grant', () => {
    expect(patch).toContain('sessionMaxAgeSeconds: 86400')
    expect(patch).not.toContain('sessionMaxAgeSeconds: 900')
  })

  it('keeps legacy sessions valid while routing new HIVE turns through the streaming model', () => {
    expect(patch).toContain('off: none')
    expect(patch).toContain('reasoning: off')
    expect(patch).toContain('cloudflare-openrouter-streaming:')
    expect(patch).toContain('reasoning: low')
    expect(patch).toContain('thinkingFormat: openrouter')
    // Cloudflare's OpenRouter route accepts strict:false; the SDK's generic
    // Cloudflare detector otherwise omits it and upstream forces all fields.
    expect(patch.match(/supportsStrictMode: true/g)).toHaveLength(2)
    expect(patch).not.toContain('reasoningEffort: off')
    expect(patch).toContain('id: openrouter/deepseek/deepseek-v4-flash-0731')
    expect(patch).toContain('provider: cloudflare-openrouter-streaming')
    expect(patch).toContain('model: openai/gpt-6-luna')
    expect(patch).toContain('id: session-title-llm\n  disabled: true')
  })

})
