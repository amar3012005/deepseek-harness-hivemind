import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeSessionBinding, nativePrincipalAllowed } from '../src/native-consent.ts'
import { principalMembershipActive } from '../src/principal-membership.ts'
test('native marker is validated, web never gains new required permissions', async () => {
  assert.equal(nativeSessionBinding(undefined), undefined)
  assert.throws(() => nativeSessionBinding('bad'))
  let calls = 0
  assert.equal(await nativePrincipalAllowed({ profile:'hivemind-chat' }, async () => { calls++; return false }),true)
  assert.equal(calls,0)
  assert.equal(await nativePrincipalAllowed({ native_session_hash:'bad' },async()=>true),false)
})
test('existing native principal revalidates every time through signed boundary', async () => {
  let active = true
  let requests = 0
  const principal={ native_session_hash:'a'.repeat(64) }
  const fetcher=(async (_url:unknown, options:RequestInit|undefined) => {
    assert.equal(new Headers(options?.headers).get('authorization'),'Bearer fixture-signed-token')
    requests++
    return new Response(JSON.stringify({ active }),{ status:active?200:403 })
  }) as typeof fetch
  const check=()=>principalMembershipActive('https://core.test','fixture-signed-token',new AbortController().signal,fetcher)
  assert.equal(await nativePrincipalAllowed(principal,check),true)
  active=false
  assert.equal(await nativePrincipalAllowed(principal,check),false)
  assert.equal(requests,2)
})
test('native boundary outage denies, malformed grants never pass',async()=>{
  assert.equal(await nativePrincipalAllowed({ native_session_hash:'a'.repeat(64) },async()=>{throw Error('offline')}),false)
})
