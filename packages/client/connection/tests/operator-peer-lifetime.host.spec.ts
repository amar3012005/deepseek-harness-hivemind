import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { OperatorPeer } from '../src/operator-peer.ts'

describe('OperatorPeer scope ownership', () => {
  it('keeps sibling tenant peers independent and tears them down with their native parent', async () => {
    const host = new Context()
    const operator = new OperatorPeer(host)
    const firstTenant = new OperatorPeer(operator.ctx)
    const secondTenant = new OperatorPeer(operator.ctx)
    const closed: string[] = []

    firstTenant.ctx.effect(() => () => { closed.push('first') }, 'test: first tenant stream')
    secondTenant.ctx.effect(() => () => { closed.push('second') }, 'test: second tenant stream')

    expect(firstTenant).not.toBe(secondTenant)
    expect(firstTenant.ctx).not.toBe(secondTenant.ctx)

    await firstTenant.dispose()
    expect(closed).toEqual(['first'])

    // Disposing one tenant cannot tear down a sibling, but the Connection
    // operator remains the deliberate parent lifetime for both tenant peers.
    await operator.dispose()
    expect(closed).toEqual(['first', 'second'])
  })
})
