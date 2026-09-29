/** Durable model-facing media workflow over replaceable generation providers and native jobs. */
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenerationFormat, GenerationReceipt } from './generation.ts'
import { GenerationRegistry, generateArtifact } from './generation.ts'
import { GenerationProviderError } from './image-provider.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { media: 'media' }
}

interface MediaStart {
  readonly workflowId: string
  readonly jobId: string
  readonly kind: 'image' | 'video'
  readonly title: string
  readonly provider: string
  readonly attemptLimit: number
  readonly startedAt: number
}
interface MediaEnd extends MediaStart {
  readonly status: 'completed' | 'failed' | 'killed'
  readonly attempts: number
  readonly finishedAt: number
  readonly artifactId?: string
  readonly sha256?: string
  readonly diagnostic?: string
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Media work admitted into a native, owner-scoped background job. */
    'hivemind/media-workflow-started': MediaStart
    /** Terminal media outcome paired with its start by workflowId and jobId. */
    'hivemind/media-workflow-ended': MediaEnd
  }
}

function sourceImage(agent: Agent, artifactId: string | undefined): string | undefined {
  if (!artifactId) return undefined
  const event = [...agent.session.snapshotEvents()].reverse().find(item => item.type === 'hivemind/generation-created' && (item.data as GenerationReceipt).artifactId === artifactId)
  if (!event) throw new Error('source_artifact_id is not a generated artifact in this session')
  const receipt = event.data as GenerationReceipt
  if (!receipt.mediaType.startsWith('image/')) throw new Error('source_artifact_id must identify an image')
  const cwd = resolve(agent.session.header.cwd ?? process.cwd())
  const path = resolve(receipt.path); const rel = relative(cwd, path)
  if (!isAbsolute(path) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Source image is outside this session workspace')
  return path
}

function retryDelay(attempt: number, baseMs: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, baseMs * (2 ** (attempt - 1))))
}

/** Register one compact start tool; native job tools own wait, status, cancellation, and wake-up. */
export function registerMediaWorkflow(
  ctx: Context,
  registry: GenerationRegistry,
  outputDirectory: string,
  config: {
    readonly maxBriefChars: number
    readonly imageAttempts: number
    readonly retryBaseDelayMs: number
  },
): void {
  ctx.tools.register(defineTool({
    name: 'hivemind_media_generate',
    description: 'Start reliable image or video creation as a durable background job. Use one complete brief; the workflow validates inputs, uses the configured provider, stores the artifact, and wakes this session on completion. Track the returned job_id with native job tools. Do not start a duplicate while it is running.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['image', 'video'] },
      title: { type: 'string', required: true },
      brief: { type: 'string', required: true, description: 'Complete creative brief including audience, composition, brand constraints, exact copy, and exclusions.' },
      aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'] },
      duration_seconds: { type: 'number', description: 'Video only; whole seconds from 4 through 15.' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Image only; up to eight public HTTPS references.' },
      source_artifact_id: { type: 'string', description: 'Video only; exact artifact id of an image generated earlier in this session.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      const agent = execution.agent
      if (!agent) throw new Error('Media generation requires an active session')
      const kind = args.kind as 'image' | 'video'; const title = args.title.trim(); const brief = args.brief.trim()
      if (!title || title.length > 240) throw new Error('title must contain 1–240 characters')
      if (!brief || brief.length > config.maxBriefChars) throw new Error(`brief must contain 1–${config.maxBriefChars} characters`)
      if (kind === 'image' && args.duration_seconds !== undefined) throw new Error('duration_seconds applies only to video')
      if (kind === 'video' && args.reference_images?.length) throw new Error('Use source_artifact_id for video input')
      if (kind === 'image' && args.source_artifact_id) throw new Error('source_artifact_id applies only to video')
      if (args.duration_seconds !== undefined && (!Number.isInteger(args.duration_seconds) || args.duration_seconds < 4 || args.duration_seconds > 15)) throw new Error('duration_seconds must be a whole number from 4 through 15')
      const references = args.reference_images ?? []
      if (references.length > 8 || references.some((value) => { try { const url = new URL(value); return url.protocol !== 'https:' || Boolean(url.username || url.password) } catch { return true } })) throw new Error('reference_images must contain at most eight public HTTPS URLs')
      const provider = registry.get(kind as GenerationFormat)
      const availability = await provider.availability?.()
      if (availability && !availability.ready) return { status: 'awaiting_input', code: availability.code, action: availability.action, provider: provider.id }
      const sourcePath = sourceImage(agent, args.source_artifact_id)
      const workflowId = randomUUID(); const attemptLimit = kind === 'image' ? config.imageAttempts : 1
      const startedAt = Date.now(); let jobId = ''; let controller: AbortController | undefined
      const execute = async (jobController: AbortController) => {
        let attempts = 0
        try {
          while (true) {
            attempts += 1
            try {
              const receipt = await generateArtifact(ctx, registry, outputDirectory, {
                format: kind, title, content: brief, referenceImages: references,
                ...(sourcePath ? { sourcePath } : {}), ...(args.aspect_ratio ? { aspectRatio: args.aspect_ratio } : {}),
                ...(args.duration_seconds === undefined ? {} : { durationSeconds: args.duration_seconds }),
              }, agent, jobController.signal)
              const base = { workflowId, jobId, kind, title, provider: provider.id, attemptLimit, startedAt }
              agent.session.append('hivemind/media-workflow-ended', { ...base, status: 'completed', attempts, finishedAt: Date.now(), artifactId: receipt.artifactId, sha256: receipt.sha256 })
              return { status: 'completed' as const, detail: `${kind} artifact created`, output: JSON.stringify({ workflow_id: workflowId, artifact_id: receipt.artifactId, sha256: receipt.sha256, status: 'completed' }) }
            } catch (error) {
              if (!(error instanceof GenerationProviderError) || !error.retryable || attempts >= attemptLimit) throw error
              await retryDelay(attempts, config.retryBaseDelayMs)
            }
          }
        } catch (error) {
          const killed = jobController.signal.aborted
          const base = { workflowId, jobId, kind, title, provider: provider.id, attemptLimit, startedAt }
          const diagnostic = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
          agent.session.append('hivemind/media-workflow-ended', { ...base, status: killed ? 'killed' : 'failed', attempts, finishedAt: Date.now(), diagnostic })
          return { status: killed ? 'killed' as const : 'failed' as const, detail: diagnostic, output: JSON.stringify({ workflow_id: workflowId, status: killed ? 'killed' : 'failed', diagnostic }) }
        }
      }
      jobId = String(ctx.jobs.start({
        kind: 'media', label: `${kind}: ${title}`, owner: agent, outputLimitBytes: 4_000,
        run: () => {
          controller = new AbortController()
          return { cancel: reason => controller?.abort(reason), done: execute(controller) }
        },
      }))
      const start: MediaStart = { workflowId, jobId, kind, title, provider: provider.id, attemptLimit, startedAt }
      agent.session.append('hivemind/media-workflow-started', start)
      return { workflow_id: workflowId, job_id: jobId, status: 'running', provider: provider.id, attempt_limit: attemptLimit, next: 'Continue independent work or use job_output with this job_id when blocked.' }
    },
    presentCall: args => ({ card: 'generic', title: `Generate ${String(args.kind ?? 'media')}`, kind: 'read', rawInput: String(args.title ?? '') }),
  }))
}
