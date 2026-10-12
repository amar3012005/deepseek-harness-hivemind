/** Authenticated media coordinates; never accepted from model arguments. */
export interface MediaOwner { orgId: string; userId: string; sessionId: string }
export type GenerationFormat = 'markdown_report' | 'pdf' | 'presentation' | 'spreadsheet' | 'web' | 'image' | 'video'
export const designProfiles = ['executive', 'editorial', 'campaign', 'product', 'data'] as const
export type DesignProfile = typeof designProfiles[number]
export interface DesignQuality {
  readonly status: 'ready' | 'needs_review'
  readonly checks: string[]
  readonly warnings: string[]
}
