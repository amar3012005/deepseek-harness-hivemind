import { afterEach, describe, expect, it, vi } from 'vitest'
import { decimalAmount, minorUnits } from '../src/calculator.ts'
import { openRouterImageProvider } from '../src/image-provider.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('generation provider boundaries', () => {
  it('keeps decimal arithmetic exact even beyond Number precision', () => {
    expect(decimalAmount(minorUnits('0.10') + minorUnits('0.20'))).toBe('0.30')
    expect(decimalAmount(minorUnits('999999999999999999.99'))).toBe('999999999999999999.99')
    expect(decimalAmount(minorUnits('-10.01') + minorUnits('0.01'))).toBe('-10.00')
    for (const invalid of ['1.234', 'NaN', '1e3', 'EUR 4', '1,000']) expect(() => minorUnits(invalid)).toThrow()
  })

  const config = { baseURL: 'https://example.test/v1', apiKeyEnv: 'GENERATION_TEST_KEY', model: 'image-test', timeoutMs: 1000 }
  const request = { title: 'Brand asset', content: 'Create a draft', cwd: '/tmp', signal: new AbortController().signal }

  it('fails before network access when credentials are absent', async () => {
    vi.stubEnv('GENERATION_TEST_KEY', '')
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(openRouterImageProvider(config).generate(request)).rejects.toThrow('not configured')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves embedded errors and never fabricates an artifact for text-only output', async () => {
    vi.stubEnv('GENERATION_TEST_KEY', 'test-only')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ error: { code: 429 } })).mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'No image' } }] })))
    await expect(openRouterImageProvider(config).generate(request)).rejects.toThrow('429')
    await expect(openRouterImageProvider(config).generate(request)).rejects.toThrow('no supported inline image')
  })
})
