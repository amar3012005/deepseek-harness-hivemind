import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { DesignProfile, DesignQuality, GenerationFormat, MediaOwner } from './contracts.ts'
import type {} from '@deepseek-ai/dsh-session/types'

export interface GenerationReceipt {
  readonly owner?: MediaOwner
  readonly sourceFormat?: 'html'
  readonly uploadedImageIds?: readonly string[]
  readonly savedImageIds?: readonly string[]
  readonly artifactId: string
  readonly title: string
  readonly format: GenerationFormat
  readonly mediaType: string
  readonly provider: string
  readonly path: string
  readonly file: FileAttachmentRef
  readonly sha256: string
  readonly pageCount?: number
  readonly preview?: ImageAttachmentRef
  readonly designProfile?: DesignProfile
  readonly designQuality?: DesignQuality
  readonly content?: readonly [{ readonly type: 'image'; readonly attachment: ImageAttachmentRef }]
}
export interface ArtifactCreated {
  readonly artifactId: string
  readonly title: string
  readonly mediaType: 'application/pdf'
  readonly provider: string
  readonly path: string
  readonly pageSize: 'A4' | 'Letter'
  readonly pageCount: number
  readonly pdfBytes: number
  readonly pdf: FileAttachmentRef
  readonly preview: ImageAttachmentRef
  readonly designProfile?: DesignProfile
  readonly designQuality: DesignQuality
}
export interface MediaStart {
  readonly owner?: MediaOwner
  readonly request?: string
  readonly operationId?: string
  readonly workflowId: string
  readonly jobId: string
  readonly kind: 'image' | 'video'
  readonly title: string
  readonly provider: string
  readonly attemptLimit: number
  readonly startedAt: number
}
export interface MediaEnd extends MediaStart {
  readonly status: 'completed' | 'failed' | 'killed'
  readonly attempts: number
  readonly finishedAt: number
  readonly artifactId?: string
  readonly sha256?: string
  readonly diagnostic?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records a saved generation receipt with artifact identity, provider, attachment and content digest. */
    'hivemind/generation-created': GenerationReceipt
    /** Records a saved PDF artifact with its attachment, preview, page metrics and design quality. */
    'hivemind/artifact-created': ArtifactCreated
    /** Records a media workflow admission with owner, provider, job identity and attempt budget. */
    'hivemind/media-workflow-started': MediaStart
    /** Records the terminal media workflow status, attempts, artifact identity and diagnostic. */
    'hivemind/media-workflow-ended': MediaEnd
  }
}
