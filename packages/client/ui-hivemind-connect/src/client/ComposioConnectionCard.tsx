import { useMemo, useState } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ComposioConnectionCard.module.css'

interface ConnectionCardInjected {
  continueWorkflow: (app: string) => Promise<void>
}

type Props = ToolCallViewProps & PropsLocale<'hivemind-connect'> & InjectFace<ConnectionCardInjected>
interface Receipt {
  readonly action?: string
  readonly status?: string
  readonly toolkit?: string
  readonly app_label?: string
  readonly logo_url?: string
  readonly prompt?: string
  readonly redirect_url?: string
  readonly redirectUrl?: string
  readonly draft_id?: string
  readonly summary?: string
  readonly error?: string
  readonly operations?: readonly OperationReceipt[]
}

interface OperationReceipt {
  readonly tool?: string
  readonly status?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function settledPayload(block: ToolCallViewProps['block']): unknown {
  if (!('kind' in block)) return undefined
  const item = block.content.find(value => value.type === 'text')
  if (item?.type !== 'text') return undefined
  try {
    return JSON.parse(item.text) as unknown
  } catch {
    return { summary: item.text }
  }
}

function findReceipt(value: unknown, depth = 0): Receipt | undefined {
  if (depth > 6) return undefined
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findReceipt(entry, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!record(value)) return undefined
  const candidate = value as Receipt
  if (candidate.redirect_url || candidate.redirectUrl || candidate.draft_id
    || candidate.action || candidate.status || candidate.summary || candidate.error) return candidate
  for (const entry of Object.values(value)) {
    const found = findReceipt(entry, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

/** Replay-stable projection of the durable Composio tool receipt. */
export function ComposioConnectionCard({ block, continueWorkflow, inspect, t }: Props) {
  const [continuing, setContinuing] = useState(false)
  const receipt = useMemo(() => findReceipt(settledPayload(block)), [block])
  const redirect = receipt?.status === 'ready' ? undefined : safeHttpsUrl(receipt?.redirect_url ?? receipt?.redirectUrl)
  const toolkit = receipt?.toolkit || t('composio.app')
  const app = receipt?.app_label || toolkit.split(/[-_\s]+/).filter(Boolean)
    .map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ')
  const running = !('kind' in block)
  const failed = 'kind' in block && block.isError
  const logo = safeHttpsUrl(receipt?.logo_url)
    || `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`
  const draft = receipt?.draft_id !== undefined || receipt?.status === 'draft_created'
  const title = running ? t('composio.checking')
    : receipt?.status === 'connection_pending' ? t('composio.connectionPending')
      : receipt?.status === 'connection_required' || redirect ? t('composio.connectionRequired')
        : draft ? t('composio.approvalRequired')
          : failed ? t('composio.failed') : t('composio.completed')
  return <section className={css.root} aria-live="polite"><button className={css.summary} type="button" onClick={inspect} disabled={inspect===undefined} aria-label={t('composio.inspect')}><span className={css.symbol} aria-hidden="true">✦</span><span>{title}</span>{receipt?.status?<span className={css.status}>{receipt.status.replaceAll('_',' ')}</span>:null}</button>
    {receipt?.operations?.map((operation, index) => operation.tool?<div className={css.operation} key={`${operation.tool}:${index}`}><span className={css.symbol} aria-hidden="true">✦</span><code>{operation.tool}</code>{operation.status?<span className={css.operationStatus}>→ {operation.status}</span>:null}</div>:null)}
    {receipt?.status==='connection_required'?<><p className={css.prompt}>{receipt.prompt||t('composio.connectionPrompt',{ app })}</p>{redirect?<a className={css.connection} href={redirect} target="_blank" rel="noreferrer"><img src={logo} alt=""/><span><strong>{t('composio.connect',{ app })}</strong><small>{t('composio.connectionActionDetail')}</small></span></a>:null}<button className={css.continue} type="button" disabled={continuing} onClick={() => { setContinuing(true); void continueWorkflow(app).catch(() => setContinuing(false)) }}>{continuing?t('composio.continuing'):t('composio.connectedContinue',{ app })}</button></>:null}
    {redirect&&receipt?.status!=='connection_required'?<div className={css.connection}><div><strong>{t('composio.connect',{ app })}</strong><p>{t('composio.connectDetail')}</p></div><a href={redirect} target="_blank" rel="noreferrer">{t('composio.authorize')}</a></div>:null}
    {draft?<p className={css.detail}>{t('composio.draftDetail')}</p>:null}{!redirect&&!draft&&receipt?.summary?<p className={css.detail}>{receipt.summary}</p>:null}{receipt?.error?<p className={css.error}>{receipt.error}</p>:null}</section>
}
