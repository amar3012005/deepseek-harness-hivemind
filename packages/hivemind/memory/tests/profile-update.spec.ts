import { describe, expect, it, vi } from 'vitest'
import { registerProfileUpdate } from '../src/profile-update.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

function fixture(selection = 'Approve') {
  let tool: ToolDefinition | undefined
  const events: { type: string; data: Record<string, unknown>; ignorable: boolean }[] = []
  const ask = vi.fn(async (input: { questions: { id: string }[] }) => ({
    answers: [{ id: input.questions[0]!.id, selected: [selection] }],
  }))
  const update = vi.fn(async () => ({ status: 'updated', fields: { name: 'ASTER HELIUS' } }))
  const dispose = vi.fn()
  registerProfileUpdate({
    tools: { register: (value: ToolDefinition) => { tool = value; return dispose } }, get: () => ({ ask }),
  } as never, update)
  const execution = { callId: 'profile-call', signal: new AbortController().signal, agent: { session: {
    snapshotEvents: () => events,
    append: (type: string, data: Record<string, unknown>, options: { ignorable: boolean }) => events.push({ type, data, ...options }),
  } } }
  return { run: (fields: unknown) => tool!.execute({ fields }, execution as never), events, update, ask }
}

describe('native profile approval', () => {
  it('shows exact fields, writes only after approval, and replays a completed receipt', async () => {
    const f = fixture()
    f.ask.mockImplementationOnce(async (input) => {
      expect(f.update).not.toHaveBeenCalled()
      expect(input.questions[0]).toMatchObject({ detail: 'name: ASTER HELIUS' })
      return { answers: [{ id: input.questions[0]!.id, selected: ['Approve'] }] }
    })
    await expect(f.run({ name: 'ASTER HELIUS' })).resolves.toMatchObject({ status: 'updated' })
    await f.run({ name: 'ASTER HELIUS' })
    expect(f.update).toHaveBeenCalledTimes(1)
    expect(f.ask).toHaveBeenCalledTimes(1)
    expect(f.events.map(e => e.data['status'])).toEqual(['prepared', 'approved', 'completed'])
    expect(f.events.every(e => e.ignorable)).toBe(true)
  })
  it('cancels without a write and keeps cancellation terminal on replay', async () => {
    const f = fixture('Cancel')
    await expect(f.run({ name: 'ASTER HELIUS' })).resolves.toMatchObject({ status: 'cancelled' })
    await f.run({ name: 'ASTER HELIUS' })
    expect(f.update).not.toHaveBeenCalled()
    expect(f.ask).toHaveBeenCalledTimes(1)
  })
  it('rejects identity overrides, empty changes and permission fields before approval', async () => {
    const f = fixture()
    for (const fields of [{ user_id: 'other' }, { isAdmin: 'true' }, {}, { name: ' ' }]) await expect(f.run(fields)).rejects.toThrow()
    expect(f.ask).not.toHaveBeenCalled()
    expect(f.update).not.toHaveBeenCalled()
  })
  it('records failure instead of claiming an unsuccessful write completed', async () => {
    const f = fixture()
    f.update.mockRejectedValueOnce(new Error('service unavailable'))
    await expect(f.run({ name: 'ASTER HELIUS' })).rejects.toThrow('service unavailable')
    expect(f.events.at(-1)?.data['status']).toBe('failed')
  })
})
