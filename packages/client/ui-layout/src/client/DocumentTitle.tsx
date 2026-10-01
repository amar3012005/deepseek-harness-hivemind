/** Browser title selection follows the active main panel without subscribing the frame. */
import { useEffect } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Props for the browser title projection. */
export type DocumentTitleProps = Pick<PropsRuntime<'root'>, 'useSessions' | 'usePanelInfo'> & {
  /** Build-configured or localized product title. */
  productTitle: string
}

/**
 * Project the selected durable session title into the browser title and
 * restore the build-selected product title when unmounted.
 * @param props - Selected session title projection.
 * @returns No rendered content.
 */
export function DocumentTitle({ useSessions, usePanelInfo, productTitle }: DocumentTitleProps): null {
  const showSessionTitle = usePanelInfo(info => info.activePanelId === null)
  const title = useSessions((state) => {
    const current = state.current
    return !showSessionTitle || current === undefined ? undefined : state.byId[current]?.title
  })
  useEffect(() => {
    const hive = document.documentElement.dataset.dshMode === 'hivemind-chat'
    const visibleTitle = hive && (title === 'deepseek-harness' || title === 'DeepSeek Harness') ? undefined : title
    const brand = hive ? 'HIVEMIND' : productTitle
    document.title = visibleTitle === undefined ? brand : `${visibleTitle} — ${brand}`
    return () => { document.title = productTitle }
  }, [productTitle, title])
  return null
}
