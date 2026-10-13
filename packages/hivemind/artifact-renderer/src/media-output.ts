/** Producer-owned native job output enrichment with its saved result pixels. */
import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Keep the job service generic; only this producer's matched terminal receipt supplies an image. */
export function installMediaJobPreview(ctx: Context): void {
  ctx.on('tools/post-execute', async (execution, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'accept' || 'value' in decision || decision.content !== undefined
      || result.isError || !execution.agent) return decision
    const events = execution.agent.session.snapshotEvents()
    const value = object(result.value)
    let artifactId: string | undefined
    if (execution.name === 'job_output') {
      const args = object(execution.arguments)
      const job = object(value?.['job'])
      if (job?.['kind'] !== 'media' || job['status'] !== 'completed' || typeof job['id'] !== 'string'
        || args?.['job_id'] !== job['id']) return decision
      const terminal = events.findLast(event => event.type === 'hivemind/media-workflow-ended' && event.data.jobId === job['id'])
      if (terminal?.type !== 'hivemind/media-workflow-ended' || terminal.data.status !== 'completed'
        || !terminal.data.artifactId) return decision
      artifactId = terminal.data.artifactId
    } else if (execution.name === 'hivemind_media_generate') {
      // The generate tool waits for a finished image, so its completed result
      // carries the saved artifact. Require the matching terminal receipt.
      const completedId = value?.['artifact_id']
      if (value?.['status'] !== 'completed' || typeof completedId !== 'string' || completedId.length === 0) return decision
      const terminal = events.findLast(event => event.type === 'hivemind/media-workflow-ended'
        && event.data.artifactId === completedId)
      if (terminal?.type !== 'hivemind/media-workflow-ended' || terminal.data.status !== 'completed') return decision
      artifactId = completedId
    } else return decision
    const generated = events.findLast(event => event.type === 'hivemind/generation-created'
      && event.data.artifactId === artifactId)
    if (generated?.type !== 'hivemind/generation-created' || !generated.data.mediaType.startsWith('image/')) return decision
    const preview = generated.data.preview
    if (!preview || !Number.isSafeInteger(preview.bytes) || preview.bytes <= 0 || preview.bytes > 30 * 1024 * 1024
      || !Number.isSafeInteger(preview.width) || !Number.isSafeInteger(preview.height)
      || preview.width <= 0 || preview.height <= 0 || preview.width * preview.height > 40_000_000) return decision
    if (result.content.some(part => part.type === 'image' && 'attachment' in part
      && part.attachment.attachmentId === preview.attachmentId)) return decision
    execution.signal.throwIfAborted()
    return { ...decision, content: [...result.content,
      { type: 'text', text: `Saved generated image ${generated.data.artifactId}: actual result pixels follow. Inspect them against the user's request before reporting quality; reuse this saved artifact if a revision is needed.` },
      { type: 'image', attachment: preview },
    ] }
  })
}
