import { describe, expect, it } from 'vitest'
import { claimLiveArtifactPreview } from '../src/client/live-artifact-preview.ts'

describe('artifact Preview live admission', () => {
  it('does not open closed historical receipts or preexisting open turns', () => {
    expect(claimLiveArtifactPreview('closed', 110, 100, 'closed')).toBe(false)
    expect(claimLiveArtifactPreview('old-open', 90, 100, 'open')).toBe(false)
    expect(claimLiveArtifactPreview('boundary', 100, 100, 'open')).toBe(false)
    expect(claimLiveArtifactPreview('session', 110, 100, undefined)).toBe(false)
  })
  it('opens a new live receipt once, retaining explicit historical access independently', () => {
    expect(claimLiveArtifactPreview('live-once', 110, 100, 'open')).toBe(true)
    expect(claimLiveArtifactPreview('live-once', 110, 100, 'open')).toBe(false)
  })
})
