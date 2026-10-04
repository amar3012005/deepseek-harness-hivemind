import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { currentDesignReference, installNativeDesignSkillReference, readPrivateReference, referenceOwnerKey } from '../src/design-reference.ts'
import { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult, PostToolDecision } from '@deepseek-ai/dsh-tools'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

describe('private owner-scoped visual reference', () => {
  it('preserves the image in the real native tool pipeline final model-facing result', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    {
      const preview = { attachmentId: 'pixels', mediaType: 'image/png', bytes: 20, width: 800, height: 600 }
      ctx.on('hivemind/design-reference', async () => ({ id: 'cream-orange', sha256: 'hash', preview }) as never)
      ctx.tools.register(defineTool({ name: 'skill', description: 'Native loader shape', parameters: { name: { type: 'string', required: true } },
        output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async () => ({ name: 'design-artifact', provider: 'bundled', content: 'Native design instructions' }),
      }))
      installNativeDesignSkillReference(ctx)
      const agent = { session: { snapshotEvents: () => [] } } as unknown as Agent
      const result = await ctx.tools.execute({ name: 'skill', arguments: { name: 'design-artifact' }, callId: ToolCallId('design-load'), agent, signal: new AbortController().signal })
      expect(result.isError).toBe(false)
      expect(result.content).toContainEqual({ type: 'image', attachment: preview })
      expect(result.content[0]).toMatchObject({ type: 'text' })
    }
  })
  it('enriches the successful native skill result with actual image pixels before authoring', async () => {
    let listener!: (
      execution: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>,
    ) => Promise<PostToolDecision>
    const preview = { attachmentId: 'private-pixels', mediaType: 'image/png', bytes: 200, width: 800, height: 600 }
    let reads = 0
    const ctx = { on: (_name: string, callback: typeof listener) => { listener = callback }, serial: async () => { reads++; return { id: 'cream-orange', sha256: 'hash', preview } } } as unknown as Context
    installNativeDesignSkillReference(ctx)
    let events: unknown[] = []
    const execution = { name: 'skill', arguments: { name: 'design-artifact' }, signal: new AbortController().signal, agent: { session: { snapshotEvents: () => events } } } as unknown as ToolExecution
    const result = { isError: false, value: { name: 'design-artifact' }, content: [{ type: 'text', text: 'Native design skill' }] } as ToolExecutionResult
    const next = async (): Promise<PostToolDecision> => ({ kind: 'accept' })
    const decision = await listener(execution, result, next)
    expect(decision).toMatchObject({ kind: 'accept', content: expect.arrayContaining([{ type: 'image', attachment: preview }]) })
    expect(JSON.stringify(decision)).toContain('homepage is factual context, not approved Brand DNA')
    expect(reads).toBe(1)
    await listener({ ...execution, name: 'hivemind_skills' }, result, next)
    expect(reads).toBe(1)
    events = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'user-reference' } }] } }]
    expect(await listener(execution, result, next)).toEqual({ kind: 'accept' })
    expect(reads).toBe(1)
    events = [{ type: 'hivemind/design-reference-selected', data: { id: 'cream-orange', sha256: 'hash', preview } }]
    await listener(execution, result, next)
    expect(reads).toBe(1)
  })
  it('retains pixels across context snapshots but clears them for new initiating work', () => {
    const selected = { id: 'editorial', sha256: 'hash', preview: { attachmentId: 'pixels' } }
    const events = [{ type: 'user/message', data: { source: { kind: 'user' } } }, { type: 'hivemind/design-reference-selected', data: selected }, { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'time-context', form: 'snapshot' } } }]
    expect(currentDesignReference(events as never)).toEqual(selected)
    expect(currentDesignReference([...events, { type: 'user/message', data: { source: { kind: 'user' } } }] as never)).toBeUndefined()
    expect(currentDesignReference([...events, { type: 'user/message', data: { source: { kind: 'schedule' } } }] as never)).toBeUndefined()
    expect(currentDesignReference([...events, { type: 'turn/start', data: { turn: 2 } }] as never)).toBeUndefined()
  })
  it('selects one relevant image and keeps different users isolated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'design-reference-'))
    try {
      const root = join(directory, referenceOwnerKey('org', 'user')); await mkdir(root)
      const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      const sha256 = createHash('sha256').update(data).digest('hex')
      await writeFile(join(root, 'editorial.png'), data)
      await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, orgId: 'org', userId: 'user', references: [{ id: 'editorial', file: 'editorial.png', sha256, purposes: ['editorial', 'presentation'] }] }))
      expect((await readPrivateReference(directory, 'org', 'user', 'presentation'))?.id).toBe('editorial')
      expect(await readPrivateReference(directory, 'org', 'other', 'presentation')).toBeUndefined()
      await writeFile(join(root, 'editorial.png'), Buffer.from('corrupt'))
      await expect(readPrivateReference(directory, 'org', 'user', 'editorial')).rejects.toThrow('integrity')
      await rm(join(root, 'editorial.png'))
      await writeFile(join(directory, 'outside.png'), data); await symlink(join(directory, 'outside.png'), join(root, 'editorial.png'))
      await expect(readPrivateReference(directory, 'org', 'user', 'editorial')).rejects.toThrow('escapes')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
