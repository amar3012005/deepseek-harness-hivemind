import { describe, expect, it } from 'vitest'
import { applyDesignProfile, evaluateDesignQuality } from '../src/design-kit.ts'

describe('HIVE design kit', () => {
  it('adds a deterministic profile before authored styles and keeps an editable document', () => {
    const result = applyDesignProfile('<html><head><style>body{color:red}</style></head><body><h1>Brief</h1></body></html>', 'campaign')
    expect(result).toContain('id="hivemind-design-profile"')
    expect(result.indexOf('hivemind-design-profile')).toBeLessThan(result.indexOf('body{color:red}'))
    expect(result).toContain('<h1>Brief</h1>')
  })

  it('reports bounded deterministic checks without pretending to perform visual reasoning', () => {
    const quality = evaluateDesignQuality('<html><head><meta name="viewport" content="width=device-width"><style>@media print {}</style></head><body><h1>Brief</h1></body></html>', 'executive')
    expect(quality).toEqual(expect.objectContaining({ status: 'ready' }))
    expect(quality.checks).toContain('profile:executive')
    expect(quality.checks).toContain('responsive_viewport')
    expect(quality.warnings).toEqual([])
  })

  it('flags isolated-preview hazards for model repair or optional vision review', () => {
    const quality = evaluateDesignQuality('<html><body><img src="https://example.com/logo.png"></body></html>', 'data')
    expect(quality.status).toBe('needs_review')
    expect(quality.warnings).toEqual(expect.arrayContaining(['missing_responsive_viewport', 'remote_image_may_not_render_in_isolated_preview', 'missing_primary_heading']))
  })
})
