/** Durable model-facing media workflow over replaceable generation providers and native jobs. */
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { GenerationFormat, GenerationReceipt } from './generation.ts'
import { GenerationRegistry, generateArtifact } from './generation.ts'
import { acquireMediaAdmission, type MediaOwner, type MediaAdmissionConfig } from './media-admission.ts'
import { GenerationProviderError } from './image-provider.ts'
import { currentDesignReference } from './design-reference.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Resolve server-authenticated media ownership.
     * @param input - Native session identity, never model-owned.
     * @mode serial
     */
    'hivemind/media-owner'(input: { sessionId: string }): Promise<MediaOwner>
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { media: 'media' }
}

interface MediaStart {
  readonly owner?: MediaOwner
  /** Validated accepted request, replayed only inside its authorized session. */
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

async function referenceFiles(ctx: Context, agent: Agent, ids: readonly string[], latestUpload: boolean): Promise<{ data: Uint8Array }[]> {
  if (ids.length > 5) throw new Error('Native image editing accepts at most five reference images')
  const references: { data: Uint8Array }[] = []
  for (const id of ids) {
    const event = agent.session.snapshotEvents().find(item => item.type === 'hivemind/generation-created' && item.data.artifactId === id)
    if (event?.type !== 'hivemind/generation-created' || !event.data.mediaType.startsWith('image/')) {
      throw new Error('Reference artifact is not an image in this session')
    }
    const chunks: Uint8Array[] = []; let bytes = 0
    for await (const chunk of ctx.attachments.readFileStream(event.data.file)) {
      bytes += chunk.byteLength
      if (bytes > 30 * 1024 * 1024) throw new Error('Reference image exceeds 30 MiB')
      chunks.push(chunk)
    }
    references.push({ data: Buffer.concat(chunks) })
  }
  if (latestUpload) {
    const message = agent.session.snapshotEvents().findLast(item => item.type === 'user/message' && item.data.source.kind === 'user')
    if (message?.type === 'user/message') {
      for (const part of message.data.content) {
        if (part.type === 'image' && 'attachment' in part && part.attachment) {
          const image = await ctx.attachments.readImage(part.attachment)
          references.push({ data: image.data })
        }
      }
    }
  }
  if (references.length > 5) throw new Error('Native image editing accepts at most five reference images')
  if (references.length === 0) {
    const selected = currentDesignReference(agent.session.snapshotEvents())
    if (selected) {
      const image = await ctx.attachments.readImage(selected.preview)
      references.push({ data: image.data })
    }
  }
  return references
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
    readonly attachmentOnly?: boolean
    readonly admission?: MediaAdmissionConfig
    readonly requireOwner?: boolean
  },
): void {
  const activeOperations = new Set<string>()
  const controllers = new Set<AbortController>()
  const recovering = new Map<Agent, string>()
  const admissionLease = config.admission ? acquireMediaAdmission(config.admission) : undefined
  const admission = admissionLease?.queue
  ctx.effect(() => () => {
    for (const controller of controllers) controller.abort('Media plugin stopped')
    admissionLease?.release()
  })
  ctx.on('agent/created', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const ended = new Set(events.filter(item => item.type === 'hivemind/media-workflow-ended')
      .map(item => item.data.workflowId))
    const jobs = new Set(ctx.jobs.list(agent).map(job => String(job.id)))
    let changed = false
    for (const event of events) {
      if (event.type !== 'hivemind/media-workflow-started' || ended.has(event.data.workflowId)
        || jobs.has(event.data.jobId)) continue
      if (event.data.request && event.data.owner && config.requireOwner && (event.data.kind === 'image' || (event.data.operationId && admission?.status(event.data.owner, event.data.operationId) === 'queued'))) {
        try {
          const owner = await ctx.serial('hivemind/media-owner', { sessionId: String(agent.session.header.id) })
          if (!owner || owner.orgId !== event.data.owner.orgId || owner.userId !== event.data.owner.userId || owner.sessionId !== event.data.owner.sessionId) throw new Error('Media recovery ownership mismatch')
          if (!event.data.operationId) throw new Error('Recovery identity is missing')
          recovering.set(agent, event.data.operationId)
          await mediaTool.execute({ ...JSON.parse(event.data.request), resume_operation: true }, { agent } as ToolRunContext)
          continue
        } catch { /* Keep unknown outcomes visible; never substitute a fresh operation. */ }
        finally { recovering.delete(agent) }
      }
      agent.session.append('hivemind/media-workflow-ended', { ...event.data, status: 'killed', attempts: 0,
        finishedAt: Date.now(), diagnostic: 'This image or video run was interrupted. Its outcome is unconfirmed; reconcile the saved operation before retrying.' })
      changed = true
    }
    if (changed) await ctx.sessions.flush(agent.session)
  })
  const mediaTool = defineTool({
    name: 'hivemind_media_generate',
    description: 'Generate or edit an image directly with a complete creative brief; no capability discovery or lease is required. Video also uses this native background job tool. Use one complete brief; the workflow validates inputs, uses the configured provider, stores the artifact, and wakes this session on completion. Track the returned job_id with native job tools. Reuse operation_id on recovery. Set resume_operation only to reconcile an interrupted operation; do not change the ID to blindly regenerate. The completion artifact and preview are already visible; answer without generating again.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['image', 'video'] },
      title: { type: 'string', required: true },
      brief: { type: 'string', required: true, description: 'Complete creative brief including audience, composition, brand constraints, exact copy, and exclusions.' },
      operation: { type: 'string', enum: ['generate', 'edit'], description: 'Image operation; edit requires authorized reference images.' },
      operation_id: { type: 'string', description: 'Stable operation identity. Reuse on retries. A deliberately new output uses a new identity.' },
      resume_operation: { type: 'boolean', description: 'Reconcile an interrupted native image operation; never blindly repeat it.' },
      transparent_background: { type: 'boolean', description: 'Image only. Preserve transparency when editing unless asked to change it.' },
      reference_artifact_ids: { type: 'array', items: { type: 'string' }, description: 'Image only. Up to five generated image artifact IDs from this session.' },
      use_latest_uploaded_images: { type: 'boolean', description: 'Image only. Use image attachments from the latest user message as authorized edit references.' },
      aspect_ratio: { type: 'string', description: 'Image composition ratio as positive integers, e.g. 4:5, 3:2, 16:9, 9:16 or 1:1. Video supports 16:9, 9:16 and 1:1.' },
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
      if (args.aspect_ratio !== undefined && !/^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(args.aspect_ratio)) throw new Error('aspect_ratio must contain positive integers such as 4:5 or 16:9')
      if (kind === 'video' && args.aspect_ratio !== undefined && !['16:9', '9:16', '1:1'].includes(args.aspect_ratio)) throw new Error('Video aspect_ratio must be 16:9, 9:16 or 1:1')
      const references = args.reference_images ?? []
      if (references.length > 8 || references.some((value) => { try { const url = new URL(value); return url.protocol !== 'https:' || Boolean(url.username || url.password) } catch { return true } })) throw new Error('reference_images must contain at most eight public HTTPS URLs')
      const provider = registry.get(kind as GenerationFormat)
      const availability = await provider.availability?.()
      if (availability && !availability.ready) return { status: 'awaiting_input', code: availability.code, action: availability.action, provider: provider.id }
      if (kind === 'video' && (args.operation || args.reference_artifact_ids?.length || args.use_latest_uploaded_images
        || args.transparent_background !== undefined)) throw new Error('Image editing options do not apply to video')
      if (args.operation_id !== undefined && (!args.operation_id.trim() || args.operation_id.length > 120)) {
        throw new Error('operation_id must contain 1–120 characters')
      }
      const files = await referenceFiles(ctx, agent, args.reference_artifact_ids ?? [], args.use_latest_uploaded_images === true)
      if (args.operation === 'edit' && files.length === 0) throw new Error('Image editing requires a session-owned reference image')
      if (files.length > 0 && provider.id !== 'codex:gpt-image-2') throw new Error('Session-owned editing requires the native image provider')
      const owner = config.requireOwner ? await ctx.serial('hivemind/media-owner', { sessionId: String(agent.session.header.id) }) : undefined
      if (config.requireOwner && (!owner?.orgId || !owner.userId || owner.sessionId !== String(agent.session.header.id))) throw new Error('Authenticated media ownership is unavailable')
      const operationId = createHash('sha256').update(JSON.stringify({ session: String(agent.session.header.id),
        id: args.operation_id ?? '', kind, title, brief, references, artifacts: args.reference_artifact_ids ?? [],
        inputs: files.map(file => createHash('sha256').update(file.data).digest('hex')),
        source: args.source_artifact_id ?? '', duration: args.duration_seconds ?? null, aspect: args.aspect_ratio ?? '', transparent: args.transparent_background ?? false })).digest('hex')
      if (recovering.has(agent) && recovering.get(agent) !== operationId) throw new Error('Media recovery inputs changed; original operation was not regenerated')
      const previous = agent.session.snapshotEvents().findLast(item => item.type === 'hivemind/media-workflow-started'
        && item.data.operationId === operationId)
      const dispatchState = owner ? admission?.status(owner, operationId) : undefined
      if (previous?.type === 'hivemind/media-workflow-started') {
        const ended = agent.session.snapshotEvents().findLast(item => item.type === 'hivemind/media-workflow-ended'
          && item.data.workflowId === previous.data.workflowId)
        if (ended?.type === 'hivemind/media-workflow-ended' && ended.data.status === 'completed') {
          return { status: 'already_completed', artifact_id: ended.data.artifactId ?? '', workflow_id: previous.data.workflowId }
        }
        if (activeOperations.has(operationId)) return { status: 'running', workflow_id: previous.data.workflowId, job_id: previous.data.jobId }
        if (!args.resume_operation || (provider.id !== 'codex:gpt-image-2' && dispatchState !== 'queued')) {
          return { status: 'recovery_required', workflow_id: previous.data.workflowId,
            next: 'Reconcile this operation using resume_operation=true and unchanged inputs; never mint a new ID to retry blindly.' }
        }
      }
      const reconcileOnly = Boolean(previous && dispatchState !== 'queued')
      const sourcePath = sourceImage(agent, args.source_artifact_id)
      if (owner) admission?.reserve(owner, operationId)
      const request = JSON.stringify(args)
      const workflowId = previous?.type === 'hivemind/media-workflow-started' ? previous.data.workflowId : randomUUID(); const attemptLimit = kind === 'image' ? config.imageAttempts : 1
      const startedAt = Date.now(); let jobId = ''
      let admit!: () => void; let refuse!: (error: Error) => void
      const admitted = new Promise<void>((resolve, reject) => { admit = resolve; refuse = reject })
      activeOperations.add(operationId)
      let controller: AbortController | undefined
      const execute = async (jobController: AbortController) => {
        let attempts = 0
        let release: (() => void) | undefined
        try {
          await admitted
          if (owner && admission) release = await admission.acquire(owner, operationId, jobController.signal)
          while (true) {
            attempts += 1
            try {
              const receipt = await generateArtifact(ctx, registry, outputDirectory, {
                ...(owner ? { owner } : {}), ...(reconcileOnly ? { reconcileOnly: true } : {}),
                format: kind, title, content: brief, referenceImages: references, operationId, referenceFiles: files,
                ...(args.transparent_background === undefined ? {} : { transparentBackground: args.transparent_background }),
                ...(sourcePath ? { sourcePath } : {}), ...(args.aspect_ratio ? { aspectRatio: args.aspect_ratio } : {}),
                ...(args.duration_seconds === undefined ? {} : { durationSeconds: args.duration_seconds }),
              }, agent, jobController.signal, config.attachmentOnly ?? false)
              const base = {
                ...(owner ? { owner } : {}), operationId, workflowId, jobId, kind, title, provider: provider.id, attemptLimit, startedAt,
              }
              agent.session.append('hivemind/media-workflow-ended', { ...base, status: 'completed', attempts, finishedAt: Date.now(), artifactId: receipt.artifactId, sha256: receipt.sha256 })
              if (!(await ctx.sessions.flush(agent.session))) throw new Error('Image receipt was not durably committed')
              admission?.finish(operationId, 'completed')
              return { status: 'completed' as const, detail: `${kind} artifact created`, output: JSON.stringify({ workflow_id: workflowId, artifact_id: receipt.artifactId, sha256: receipt.sha256, status: 'completed' }) }
            } catch (error) {
              if (!(error instanceof GenerationProviderError) || !error.retryable || attempts >= attemptLimit) throw error
              await retryDelay(attempts, config.retryBaseDelayMs)
            }
          }
        } catch (error) {
          const killed = jobController.signal.aborted
          const base = {
            ...(owner ? { owner } : {}), operationId, workflowId, jobId, kind, title, provider: provider.id, attemptLimit, startedAt,
          }
          const diagnostic = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
          agent.session.append('hivemind/media-workflow-ended', { ...base, status: killed ? 'killed' : 'failed', attempts, finishedAt: Date.now(), diagnostic })
          await ctx.sessions.flush(agent.session)
          admission?.finish(operationId, killed ? 'killed' : 'failed')
          return { status: killed ? 'killed' as const : 'failed' as const, detail: diagnostic, output: JSON.stringify({ workflow_id: workflowId, status: killed ? 'killed' : 'failed', diagnostic }) }
        } finally {
          release?.(); controllers.delete(jobController); activeOperations.delete(operationId)
        }
      }
      try { jobId = String(ctx.jobs.start({
        kind: 'media', label: `${kind}: ${title}`, owner: agent, outputLimitBytes: 4_000,
        run: () => {
          controller = new AbortController()
          controllers.add(controller)
          return { cancel: reason => controller?.abort(reason), done: execute(controller) }
        },
      })) } catch (error) { activeOperations.delete(operationId); throw error }
      const start: MediaStart = {
        request, ...(owner ? { owner } : {}), operationId, workflowId, jobId, kind, title, provider: provider.id, attemptLimit, startedAt,
      }
      agent.session.append('hivemind/media-workflow-started', start)
      try {
        if (!(await ctx.sessions.flush(agent.session))) throw new Error('Image intent could not be persisted; generation was not started')
        admit()
      } catch (error) { refuse(error instanceof Error ? error : new Error('Image intent persistence failed')); throw error }
      const queued = owner && admission?.status(owner, operationId) === 'queued'
      return { workflow_id: workflowId, job_id: jobId, status: 'running', provider: provider.id, attempt_limit: attemptLimit,
        ...(queued ? { queue_status: 'queued', message: 'Your image request is queued and will start when a generation slot is available.' } : {}),
        next: 'Continue independent work or use job_output with this job_id when blocked.' }
    },
    presentCall: args => ({ card: 'generic', title: `Generate ${String(args.kind ?? 'media')}`, kind: 'read', rawInput: String(args.title ?? '') }),
  })
  ctx.tools.register(mediaTool)
}
