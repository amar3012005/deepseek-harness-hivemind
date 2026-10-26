/** Prompts sent while the subscription is opening are held under their echo's requestId and flushed on open. */

import { describe, expect, it } from 'vitest'
import { type SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { Session } from '../src/client/sessions/session.ts'
import { FakeApiClient, err, fakeRemote, ok } from './fake-api.client.ts'

const SID = 'fk-outbox' as SessionId

/** Hold the history page until released, so the session stays in `loading`. */
function holdOpen(api: FakeApiClient): () => void {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  api.onHistory = async () => {
    await gate
    return ok({ records: [], hasMore: false })
  }
  return release
}

function textPrompt(text: string) {
  return [{ type: 'text' as const, text }]
}

describe('prompt during subscription open', () => {
  it('holds the prompt while loading and sends it once on open, with the echo requestId', async () => {
    const api = new FakeApiClient()
    const release = holdOpen(api)
    const session = new Session(SID, fakeRemote(api))
    const opening = session.open()
    const handle = session.beginSubmission({ text: 'hello', mode: 'queue', attachments: [] })

    const accepted = await session.prompt(textPrompt('hello'), 'queue', undefined, handle.requestId)
    expect(accepted.ok).toBe(true)
    expect(api.callsOf('session.prompt')).toHaveLength(0)

    release()
    await opening
    await new Promise(resolve => setTimeout(resolve, 0))
    const sent = api.callsOf('session.prompt') as Array<{ requestId: string; content: unknown }>
    expect(sent).toHaveLength(1)
    expect(sent[0]?.requestId).toBe(handle.requestId)
  })

  it('drops a held prompt the Host rejects and surfaces the failure once', async () => {
    const api = new FakeApiClient()
    api.onPrompt = () => Promise.resolve(err(new RemoteError('session/model-unavailable', 'no model', { provider: 'deepseek', model: 'x' })))
    const release = holdOpen(api)
    const session = new Session(SID, fakeRemote(api))
    const opening = session.open()
    const handle = session.beginSubmission({ text: 'rejected', mode: 'queue', attachments: [] })
    await session.prompt(textPrompt('rejected'), 'queue', undefined, handle.requestId)

    release()
    await opening
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(api.callsOf('session.prompt')).toHaveLength(1)
    expect(session.getSnapshot().promptError).toMatchObject({ op: 'send' })
  })

  it('sends a prompt on an already-open session directly, without holding it', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    await session.open()
    const handle = session.beginSubmission({ text: 'now', mode: 'queue', attachments: [] })
    await session.prompt(textPrompt('now'), 'queue', undefined, handle.requestId)
    expect(api.callsOf('session.prompt')).toHaveLength(1)
  })
})
