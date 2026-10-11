import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingConnectionAuthorization } from './connection-question.ts'
import css from './ConnectionAuthorizationPanel.module.css'
import { listenForConnectionReturn } from './connection-callback.ts'

type Props = PropsRuntime<'tool.call.toolview'>
  & { matched: Pick<PendingConnectionAuthorization, 'key' | 'sessionId' | 'question' | 'presentation' | 'continue' | 'cancel'> }
  & PropsLocale<'hivemind-connect'>

/** Native Harness inline continuation for a paused connected-app authorization. */
export function ConnectionAuthorizationPanel({ matched, t, dismissible = true }: Pick<Props, 'matched' | 't'> & { dismissible?: boolean }) {
  const [verifying, setVerifying] = useState(false)
  const [returned, setReturned] = useState(false)
  const [failed, setFailed] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const { presentation, question } = matched
  const continueWorkflow = (): void => {
    setVerifying(true)
    setFailed(false)
    void matched.continue().catch(() => { setVerifying(false); setFailed(true) })
  }
  useEffect(() => listenForConnectionReturn(String(matched.sessionId), ({ status }) => {
    if (status !== 'success') return
    setReturned(true)
  }), [matched])
  return <div className={css.frame}>
    <section className={css.root} aria-labelledby={`${matched.key}-title`}>
      {dismissible && <button className={css.dismiss} type="button" aria-label={t('composio.dismiss')} disabled={cancelling || verifying} onClick={() => { setCancelling(true); void matched.cancel().catch(() => { setCancelling(false); setFailed(true) }) }}>×</button>}
      <div className={css.appCard}>
        <img src={presentation.logoUrl} alt="" />
        <strong id={`${matched.key}-title`}>{presentation.appLabel}</strong>
        <span role="status">{cancelling ? t('composio.cancelling') : verifying ? t('composio.verifying') : t('composio.connectionRequired')}</span>
      </div>
      <details className={css.reason}><summary>{t('composio.reason')}</summary><p className={css.detail}>{question.question}</p></details>
      <p className={css.detail}>{failed ? t('composio.failed') : returned ? t('composio.returned') : null}</p>
      <div className={css.actions}>
        <a className={css.connectButton} href={presentation.redirectUrl} target="_blank" rel="noreferrer">
          <span>{presentation.connectLabel}</span>
        </a>
        <Button variant="outline" onClick={continueWorkflow} disabled={verifying || cancelling}>
          {verifying ? t('composio.verifying') : presentation.continueLabel}
        </Button>
      </div>
    </section>
  </div>
}
