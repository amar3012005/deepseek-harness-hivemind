import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const suite = process.env.CRM_NATIVE_PREVIEW_ORIGIN && process.env.CRM_NATIVE_PREVIEW_APP_ID ? describe : describe.skip
suite('real Loader App Builder preview', () => {
  it('boots shipped AppBuilder and Playbooks rows with scoped schema leasing, execution and reset', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const script = fileURLToPath(new URL('./fixtures/loader-preview.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), script], {
      cwd: root, timeout: 30_000, encoding: 'utf8', env: { ...process.env, TSX_TSCONFIG_PATH: `${root}/tsconfig.base.json` },
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ passed: true, cases: [
      { preset: 'hivemind-hq', enabled: true, mounted: true, skill: 'create-crm', progressive: true },
      { preset: 'hivemind-hq', enabled: false, mounted: false, skill: null, progressive: true },
      { preset: 'hivemind-hyperagents', enabled: true, mounted: true, skill: 'create-crm', progressive: true },
      { preset: 'hivemind-hyperagents', enabled: false, mounted: false, skill: null, progressive: true },
      { preset: 'hivemind-chat', enabled: true, mounted: false, skill: null, progressive: false },
    ] })
  }, 40_000)
})
