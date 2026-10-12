/** HIVEMIND's existing SPA carrier, mounted through the native Web entry. */
import '@deepseek-ai/dsh-client-ui-theme/brand-font.css'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

declare global {
  interface Window {
    __DSH_EMBED_REQUEST__?: { container: HTMLElement; cancelled: boolean; mode?: 'native' | 'hivemind-chat' }
    __DSH_EMBED_APP__?: AppWebEntry
    __DSH_EMBED_MOUNT__?: () => Promise<void>
    __DSH_EMBED_INITIAL_MOUNT__?: Promise<void>
  }
}

/** Reuse the authenticated native boot graph and its own mount/disposal lifecycle. */
export async function mount(): Promise<void> {
  const request = window.__DSH_EMBED_REQUEST__
  if (request === undefined || request.cancelled) return
  const previous = window.__DSH_EMBED_APP__
  if (previous !== undefined) await previous.dispose()
  if (request.cancelled || window.__DSH_EMBED_REQUEST__ !== request) return
  document.documentElement.dataset.dshMode = request.mode ?? 'hivemind-chat'
  document.documentElement.dataset.dshEmbedded = 'true'
  const app = new AppWebEntry(request.container)
  const nativeDispose = app.dispose.bind(app)
  // The SPA may leave while native startup is still awaiting bundle activation.
  // Settle that startup before disposing its tree or mounting a replacement.
  const startup = app.run((reason) => { throw reason })
  app.dispose = async () => {
    await startup.catch(() => undefined)
    await nativeDispose()
  }
  window.__DSH_EMBED_APP__ = app
  try {
    await startup
    if (request.cancelled || window.__DSH_EMBED_REQUEST__ !== request) {
      if (window.__DSH_EMBED_APP__ === app) delete window.__DSH_EMBED_APP__
      await nativeDispose()
    }
  } catch (error) {
    if (window.__DSH_EMBED_APP__ === app) delete window.__DSH_EMBED_APP__
    await nativeDispose()
    throw error
  }
}

window.__DSH_EMBED_MOUNT__ = mount
window.__DSH_EMBED_INITIAL_MOUNT__ = mount()
