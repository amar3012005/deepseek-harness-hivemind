import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { consumeTicket, verifyTicket } from '../src/index.ts'
import vector from './fixtures/harness-ticket-v1.json' with { type: 'json' }

const secret = 'runner-secret-with-enough-entropy-for-tests'
const now = 1_800_000_000

function ticket(overrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: 'hivemind-control-plane', aud: 'hivemind-harness-runner', sub: 'user-1', org_id: 'org-1',
    profile: 'hivemind-chat', variation: 'control', jti: 'once', iat: now, exp: now + 60, ...overrides,
  })).toString('base64url')
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

describe('HIVE runner ticket', () => {
  it('matches the control-plane deterministic ticket vector', () => {
    expect(verifyTicket(vector.ticket, vector.secret, vector.now_ms / 1000)).toEqual(vector.claims)
  })

  it('verifies the fixed issuer, audience, profile, and bounded lifetime', () => {
    expect(verifyTicket(ticket(), secret, now)).toMatchObject({ sub: 'user-1', org_id: 'org-1', jti: 'once' })
    expect(() => verifyTicket(ticket({ aud: 'other' }), secret, now)).toThrow(/claims/u)
    expect(() => verifyTicket(ticket({ profile: 'standard' }), secret, now)).toThrow(/claims/u)
    expect(() => verifyTicket(ticket({ exp: now + 61 }), secret, now)).toThrow(/lifetime/u)
    expect(() => verifyTicket(ticket({ exp: now }), secret, now)).toThrow(/lifetime/u)
  })

  it('rejects tampering and consumes a jti once', async () => {
    const valid = ticket()
    expect(() => verifyTicket(`${valid.slice(0, -1)}x`, secret, now)).toThrow(/signature/u)
    const unused = new Set(['once'])
    const consume = async (jti: string) => unused.delete(jti)
    await expect(consumeTicket(valid, secret, consume, now)).resolves.toMatchObject({ jti: 'once' })
    await expect(consumeTicket(valid, secret, consume, now)).rejects.toThrow(/already consumed/u)
  })
})
