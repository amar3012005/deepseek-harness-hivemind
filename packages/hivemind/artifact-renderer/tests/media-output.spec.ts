import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool, type PostToolDecision, type ToolExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it } from 'vitest'
import { installMediaJobPreview } from '../src/media-output.ts'

const preview = { attachmentId: 'actual-result', mediaType: 'image/png', bytes: 200, width: 1920, height: 1080 }
const events = [
  { type: 'hivemind/media-workflow-ended', data: { jobId: 'media-1', status: 'completed', artifactId: 'saved' } },
  { type: 'hivemind/generation-created', data: { artifactId: 'saved', mediaType: 'image/png', preview } },
]
const value = { text: '{"artifact_id":"saved"}', job: { id: 'media-1', kind: 'media', status: 'completed' } }
const agent = (snapshot = events) => ({ session: { snapshotEvents: () => snapshot } }) as unknown as Agent

it('delivers actual saved image pixels through the real native tool result pipeline', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  ctx.tools.register(defineTool({
    name: 'job_output', description: 'Native output shape', parameters: { job_id: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }] },
    execute: async () => value,
  }))
  installMediaJobPreview(ctx)
  const result = await ctx.tools.execute({ name: 'job_output', arguments: { job_id: 'media-1' }, callId: ToolCallId('collect-image'),
    agent: agent(), signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(result.content).toContainEqual({ type: 'image', attachment: preview })
  expect(JSON.stringify(result.content)).toContain('actual result pixels')
  await ctx.fiber.dispose()
})

it('preserves ownership, terminal receipt matching, policy changes, bounds and image idempotency', async () => {
  let hook!: (exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>
  installMediaJobPreview({ on: (_event: string, callback: typeof hook) => { hook = callback } } as unknown as Context)
  const execution = { name: 'job_output', arguments: { job_id: 'media-1' }, agent: agent(), signal: new AbortController().signal } as unknown as ToolExecution
  const result = { isError: false, value, content: [{ type: 'text', text: value.text }] } as ToolExecutionResult
  const accept = async (): Promise<PostToolDecision> => ({ kind: 'accept' })
  expect(await hook(execution, result, accept)).toMatchObject({ content: expect.arrayContaining([{ type: 'image', attachment: preview }]) })
  for (const invalid of [
    { ...execution, arguments: { job_id: 'other' } }, { ...execution, agent: agent([]) },
    { ...execution, agent: agent([{ ...events[0]!, data: { jobId: 'other', status: 'completed', artifactId: 'saved' } }, events[1]!]) },
  ]) expect(await hook(invalid, result, accept)).toEqual({ kind: 'accept' })
  for (const status of ['running', 'failed', 'killed']) {
    expect(await hook(execution, { ...result, value: { ...value, job: { ...value.job, status } } }, accept)).toEqual({ kind: 'accept' })
  }
  const rewritten: PostToolDecision = { kind: 'accept', content: [{ type: 'text', text: 'Policy-controlled content' }] }
  expect(await hook(execution, result, async () => rewritten)).toBe(rewritten)
  expect(await hook(execution, { ...result, isError: true }, accept)).toEqual({ kind: 'accept' })
  expect(await hook(execution, { ...result, content: [...result.content, { type: 'image', attachment: preview } as never] }, accept)).toEqual({ kind: 'accept' })
  const oversized = { ...events[1]!, data: { ...events[1]!.data, preview: { ...preview, bytes: 31 * 1024 * 1024 } } }
  expect(await hook({ ...execution, agent: agent([events[0]!, oversized]) }, result, accept)).toEqual({ kind: 'accept' })
})
