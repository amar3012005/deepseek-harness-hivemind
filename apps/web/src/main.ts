/** Browser entry for the Web client. */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

type DshMode = 'native' | 'hivemind-chat'

declare global {
  interface Window {
    /** Optional host-owned mount target for the native Harness client. */
    __DSH_EMBED_REQUEST__?: {
      container: HTMLElement
      cancelled: boolean
      mode?: DshMode
    }
    /** Active embedded client retained so its host can dispose it on route exit. */
    __DSH_EMBED_APP__?: AppWebEntry
  }
}

async function mount(): Promise<void> {
  const request = window.__DSH_EMBED_REQUEST__
  if (request?.cancelled === true) return
  const mode: DshMode = request?.mode ?? (request === undefined ? 'native' : 'hivemind-chat')
  document.documentElement.dataset.dshMode = mode
  if (request !== undefined) document.documentElement.dataset.dshEmbedded = 'true'
  else delete document.documentElement.dataset.dshEmbedded
  const el = request?.container ?? document.getElementById('root')
  if (el === null) throw new Error('web app: missing mount target')
  const previous = window.__DSH_EMBED_APP__
  if (previous !== undefined) await previous.dispose()
  const app = new AppWebEntry(el)
  window.__DSH_EMBED_APP__ = app
  await app.run()
}

void mount()
