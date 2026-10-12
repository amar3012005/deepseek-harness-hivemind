import { describe, expect, it } from 'vitest'
import { validateDreamArguments } from '@deepseek-ai/dsh-hivemind-connected-apps'
import { dreamingReadSchema } from '../src/connector-schema.ts'
const binding = { grant: { id: 'ca_mail', toolkit: 'gmail', subject: 'hivemind:u', label: 'Gmail', userId: 'u' },
  contract: { slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', description: 'Read', version: 'v1', hash: 'h',
    schema: { type: 'object', properties: { query: { $ref: '#/$defs/query' } }, required: ['query'], additionalProperties: false,
      $defs: { query: { type: 'string', minLength: 2 } } } } }
describe('Scoped Dreaming read schema', () => {
  const validate = (args: unknown) => validateDreamArguments(dreamingReadSchema([binding]), args).length === 0
  it('keeps ordinary memory reads compatible with the persistent child', () => {
    expect(validate({ ids: ['8cf195d6-f2c8-453a-bd95-b8a3d70bf0b0'] })).toBe(true)
  })
  it('relocates provider references and validates exact connector arguments', () => {
    expect(validate({ connector: { accountId: 'ca_mail', tool: 'GMAIL_FETCH_EMAILS', arguments: { query: 'today' } } })).toBe(true)
    expect(validate({ connector: { accountId: 'ca_mail', tool: 'GMAIL_FETCH_EMAILS', arguments: { query: 'x' } } })).toBe(false)
  })
  it('rejects other accounts, write tools and mixed read modes', () => {
    expect(validate({ connector: { accountId: 'other', tool: 'GMAIL_FETCH_EMAILS', arguments: { query: 'today' } } })).toBe(false)
    expect(validate({ connector: { accountId: 'ca_mail', tool: 'GMAIL_SEND_EMAIL', arguments: { query: 'today' } } })).toBe(false)
    expect(validate({ ids: ['id'], connector: { accountId: 'ca_mail', tool: 'GMAIL_FETCH_EMAILS', arguments: { query: 'today' } } })).toBe(false)
  })
})
