import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingConnectionAuthorization } from './connection-question.ts'
import css from './ConnectionAuthorizationPanel.module.css'
import { listenForConnectionReturn } from './connection-callback.ts'

type Props = PropsRuntime<'tool.call.toolview'>
  & { matched: PendingConnectionAuthorization }
  & PropsLocale<'hivemind-connect'>

/** Native Harness inline continuation for a paused connected-app authorization. */
export function ConnectionAuthorizationPanel({ matched, t }: Pick<Props, 'matched' | 't'>) {
  const [verifying, setVerifying] = useState(false)
  const [connected, setConnected] = useState(false)
  const { presentation, question } = matched
  const continueWorkflow = (): void => {
    setVerifying(true)
    void matched.continue().catch(() => { setVerifying(false) })
  }
  useEffect(() => listenForConnectionReturn(String(matched.sessionId), ({ status }) => {
    if (status !== 'success') return
    setConnected(true)
    continueWorkflow()
  }), [matched])
  return <div className={css.frame}>
    <section className={css.root} aria-labelledby={`${matched.key}-title`}>
      <h2 id={`${matched.key}-title`} className={css.title}>{question.question}</h2>
      <div className={css.appCard}>
        <img src={presentation.logoUrl} alt="" />
        <span><strong>{connected ? t('composio.connected', { app: presentation.appLabel }) : presentation.connectLabel}</strong><small>{t('composio.connectionActionDetail')}</small></span>
      </div>
      <h3 className={css.inputTitle}>{t('composio.inputRequired')}</h3>
      <p className={css.detail}>{question.question}</p>
      <div className={css.actions}>
        <a className={css.connectButton} href={presentation.redirectUrl} target="_blank" rel="noreferrer">
          <img src={presentation.logoUrl} alt="" />
          <span>{connected ? t('composio.connected', { app: presentation.appLabel }) : presentation.connectLabel}</span>
        </a>
        <Button variant="outline" onClick={continueWorkflow} disabled={verifying}>
          {verifying ? t('composio.verifying') : presentation.continueLabel}
        </Button>
      </div>
    </section>
  </div>
}
