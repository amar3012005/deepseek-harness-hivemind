import { afterEach, expect, it, vi } from 'vitest'
import { probeBoot, saveNativeArtifact } from '../src/client/native-transport.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('uses shell boot transport without changing global fetch', async () => {
  vi.stubGlobal('location', { href: 'capacitor://localhost/hivemind' })
  const browser = vi.fn()
  const native = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', browser)
  vi.stubGlobal('__DSH_TRANSPORT__', { fetch: native })
  expect((await probeBoot()).status).toBe(204)
  expect(native).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: 'HEAD' }))
  expect(browser).not.toHaveBeenCalled()
})

it('keeps cancellation handled by the native action and preserves ordinary web fallback', async () => {
  const blob = new Blob(['hello'])
  vi.stubGlobal('__DSH_TRANSPORT__', undefined)
  expect(await saveNativeArtifact(blob, 'report.txt')).toBe(false)
  const save = vi.fn(async () => false)
  vi.stubGlobal('__DSH_TRANSPORT__', { saveFile: save })
  expect(await saveNativeArtifact(blob, 'report.txt')).toBe(true)
  expect(save).toHaveBeenCalledWith(blob, 'report.txt')
})

it('does not silently fall back to browser download after native failure', async () => {
  vi.stubGlobal('__DSH_TRANSPORT__', { saveFile: async () => { throw new Error('failed') } })
  await expect(saveNativeArtifact(new Blob(['x']), 'report.txt')).rejects.toThrow('failed')
})
