import { describe, expect, it, vi } from 'vitest'
import type { Composio } from '@composio/core'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { DreamConnectorService, isDreamReadTool, validateDreamArguments, type DreamContract } from '../src/dream-connectors.ts'
const contract: DreamContract = { slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', version: '20260915_00', description: 'Read emails', hash: 'h',
  schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['query'], additionalProperties: false } }
const grant = { id: 'ca_mail', toolkit: 'gmail', label: 'Gmail', subject: 'hivemind:u', userId: 'u' }
const e = { signal: new AbortController().signal } as ToolRunContext
function fixture() {
  const execute = vi.fn().mockResolvedValue({ successful: true, error: null, data: { messages: [] } })
  const receipt = vi.fn().mockResolvedValue({ receipt_id: 'receipt' }), admit = vi.fn().mockResolvedValue(undefined)
  const service = new DreamConnectorService(Promise.resolve({ tools: { execute } } as unknown as Composio), receipt, () => ({ data: [], source_receipt: { receipt_id: 'receipt' } }), 4, 12000, admit)
  return { service, execute, receipt, admit }
}
describe('Dreaming direct read contracts', () => {
  it('uses the exact account and concrete tool version in one model execution', async () => {
    const { service, execute, receipt, admit } = fixture()
    await service.execute(grant, contract, { query: 'newer_than:1d', max_results: 5 }, e)
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[1]).toEqual({ connectedAccountId: 'ca_mail', userId: 'hivemind:u', version: '20260915_00', arguments: { query: 'newer_than:1d', max_results: 5 } })
    expect(receipt).toHaveBeenCalledOnce(); expect(admit).toHaveBeenCalledOnce()
  })
  it('rejects bad fields, required fields and limits before dispatch or billing', async () => {
    const { service, execute, admit } = fixture()
    const value = await service.execute(grant, contract, { max_results: 500, guessed_field: true }, e)
    expect(value).toMatchObject({ status: 'invalid_arguments', executed: false })
    expect(execute).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled()
  })
  it('never admits a write even if the provider labelled it read-only', () => {
    expect(isDreamReadTool('GMAIL_SEND_EMAIL', ['readOnlyHint'])).toBe(false)
    expect(isDreamReadTool('GMAIL_GET_CONTACTS', [])).toBe(false)
    expect(isDreamReadTool('SLACK_SEARCH_ALL', ['readOnlyHint'])).toBe(true)
  })
  it('does not promote failed provider reads into successful evidence', async () => {
    const { service, execute } = fixture()
    execute.mockResolvedValueOnce({ successful: false, error: 'disconnected', data: {} })
    expect(await service.execute(grant, contract, { query: 'x' }, e)).toMatchObject({ status: 'read_unavailable' })
  })
  it('reuses a durable contract cache without provider discovery', async () => {
    const { service } = fixture()
    const write = vi.fn()
    expect(await service.contracts('gmail', { read: async () => [contract], write })).toEqual([contract])
    expect(write).not.toHaveBeenCalled()
  })
  it('retains nested constraints and does not coerce model input', () => {
    expect(validateDreamArguments(contract.schema, { query: 'x', max_results: '5' })).not.toEqual([])
  })
})
