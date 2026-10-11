import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ComposioConnectionCard.module.css'

type Props = ToolCallViewProps & PropsLocale<'hivemind-connect'>
/** Tool details remain inspectable; the native status row and input dock own app progress and actions. */
export function ComposioConnectionCard({ inspect, t }: Props) {
  return <section className={css.root}><button className={css.summary} type="button"
    onClick={inspect} disabled={inspect === undefined} aria-label={t('composio.inspect')}>
    <span>{t('composio.inspect')}</span>
  </button></section>
}
