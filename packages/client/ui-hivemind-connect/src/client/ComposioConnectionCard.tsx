import { useMemo } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ConnectionAuthorizationPanel } from './ConnectionAuthorizationPanel.tsx'
import { PendingConnectionAuthorization } from './connection-question.ts'
import css from './ComposioConnectionCard.module.css'

type Props = ToolCallViewProps & PropsLocale<'hivemind-connect'>
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
  readonly connected_toolkits?: readonly string[]
  readonly results?: readonly SearchResultReceipt[]
  readonly operations?: readonly OperationReceipt[]
}

interface SearchResultReceipt {
  readonly toolkits?: readonly string[]
  readonly primary_tool_slugs?: readonly string[]
}

interface OperationReceipt {
  readonly tool?: string
  readonly status?: string
}

interface CallArguments {
  readonly tool_slug?: string
  readonly toolkits?: readonly string[]
  readonly apps?: readonly string[]
  readonly queries?: readonly { readonly app?: string }[]
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

function isAuthorizationCancellation(receipt: Receipt | undefined): boolean {
  const message = receipt?.error ?? receipt?.summary
  return typeof message === 'string'
    && message.toLowerCase().includes('user cancelled connected-app authorization')
}

function callArguments(block: ToolCallViewProps['block']): CallArguments | undefined {
  const raw = 'kind' in block ? block.call?.argsRaw : block.argsRaw
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return record(parsed) ? parsed as CallArguments : undefined
  } catch {
    return undefined
  }
}

function toolkitFromTool(tool: string | undefined): string | undefined {
  if (tool === undefined || tool.startsWith('COMPOSIO_')) return undefined
  const separator = tool.indexOf('_')
  return separator > 0 ? tool.slice(0, separator).toLowerCase() : undefined
}

function normalizedToolkit(value: string | undefined): string | undefined {
  const toolkit = value?.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/^_+|_+$/g, '')
  return toolkit === '' ? undefined : toolkit
}

function receiptToolkit(receipt: Receipt | undefined, args: CallArguments | undefined): string | undefined {
  return normalizedToolkit(receipt?.toolkit)
    ?? normalizedToolkit(receipt?.connected_toolkits?.[0])
    ?? normalizedToolkit(receipt?.results?.[0]?.toolkits?.[0])
    ?? toolkitFromTool(receipt?.results?.[0]?.primary_tool_slugs?.[0])
    ?? toolkitFromTool(receipt?.operations?.find(item => !item.tool?.startsWith('COMPOSIO_'))?.tool)
    ?? toolkitFromTool(args?.tool_slug)
    ?? normalizedToolkit(args?.toolkits?.[0])
    ?? normalizedToolkit(args?.apps?.[0])
    ?? normalizedToolkit(args?.queries?.find(query => query.app !== undefined)?.app)
}

function appLabel(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean)
    .map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ')
}

function toolkitLogo(toolkit: string): string {
  return `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`
}

/** Replay-stable projection of the durable Composio tool receipt. */
export function ComposioConnectionCard({
  block, inspect, sessionId, useSessionPendingInteraction, inputActions, t,
}: Props) {
  const receipt = useMemo(() => findReceipt(settledPayload(block)), [block])
  const args = useMemo(() => callArguments(block), [block])
  const pending = useSessionPendingInteraction((snapshot) => {
    const interaction = snapshot.get(sessionId)
    return !('kind' in block) && interaction instanceof PendingConnectionAuthorization
      ? interaction
      : undefined
  })
  const redirect = receipt?.status === 'ready' ? undefined : safeHttpsUrl(receipt?.redirect_url ?? receipt?.redirectUrl)
  const toolkit = receiptToolkit(receipt, args)
  const app = receipt?.app_label || (toolkit === undefined ? t('composio.app') : appLabel(toolkit))
  const running = !('kind' in block)
  const failed = 'kind' in block && block.isError
  const cancelled = failed && isAuthorizationCancellation(receipt)
  const logo = safeHttpsUrl(receipt?.logo_url)
    || (toolkit === undefined ? undefined : toolkitLogo(toolkit))
  const draft = receipt?.draft_id !== undefined || receipt?.status === 'draft_created'
  const connected = receipt?.status === 'ready'
    && toolkit !== undefined
    && receipt.connected_toolkits?.some(value => value.toLowerCase() === toolkit) === true
  const title = running ? t('composio.checking')
    : receipt?.status === 'connection_pending' ? t('composio.connectionPending')
      : receipt?.status === 'connection_required' || redirect ? t('composio.connectionRequired')
        : draft ? t('composio.approvalRequired')
          : cancelled ? t('composio.cancelled')
            : failed ? t('composio.failed') : t('composio.completed')
  const resumeSettled = (): void => {
    inputActions.setDraft(t('composio.continue', { app }))
    queueMicrotask(() => { inputActions.submit() })
  }
  return <section className={css.root} aria-live="polite"><button className={css.summary} type="button" onClick={inspect} disabled={inspect===undefined} aria-label={t('composio.inspect')}>{logo === undefined?<span className={css.symbol} aria-hidden="true">✦</span>:<img className={css.toolLogo} src={logo} alt=""/>}<span>{title}</span>{receipt?.status?<span className={css.status}>{receipt.status.replaceAll('_',' ')}</span>:null}</button>
    {receipt?.operations?.map((operation, index) => {
      if (!operation.tool) return null
      const operationToolkit = toolkitFromTool(operation.tool) ?? toolkit
      const operationLogo = operationToolkit === undefined ? undefined : toolkitLogo(operationToolkit)
      return <div className={css.operation} key={`${operation.tool}:${index}`}>{operationLogo === undefined?<span className={css.symbol} aria-hidden="true">✦</span>:<img className={css.operationLogo} src={operationLogo} alt=""/>}<code>{operation.tool}</code>{operation.status?<span className={css.operationStatus}>→ {operation.status}</span>:null}</div>
    })}
    {pending === undefined && receipt?.status==='connection_required'?<><p className={css.prompt}>{receipt.prompt||t('composio.connectionPrompt',{ app })}</p>{redirect&&logo!==undefined?<a className={css.connection} href={redirect} target="_blank" rel="noreferrer"><img src={logo} alt=""/><span><strong>{t('composio.connect',{ app })}</strong><small>{t('composio.connectionActionDetail')}</small></span></a>:null}<div className={css.resume}><Button variant="outline" onClick={resumeSettled} disabled={inputActions===undefined}>{t('composio.continue',{ app })}</Button></div></>:null}
    {pending === undefined && connected&&logo!==undefined?<div className={`${css.connection} ${css.connected}`}><img src={logo} alt=""/><span><strong>{t('composio.connected',{ app })}</strong><small>{t('composio.connectionVerified')}</small></span></div>:null}
    {redirect&&receipt?.status!=='connection_required'?<div className={css.connection}><div><strong>{t('composio.connect',{ app })}</strong><p>{t('composio.connectDetail')}</p></div><a href={redirect} target="_blank" rel="noreferrer">{t('composio.authorize')}</a></div>:null}
    {draft?<p className={css.detail}>{t('composio.draftDetail')}</p>:null}{!cancelled&&!redirect&&!draft&&receipt?.summary?<p className={css.detail}>{receipt.summary}</p>:null}{!cancelled&&receipt?.error?<p className={css.error}>{receipt.error}</p>:null}
    {pending === undefined ? null : <ConnectionAuthorizationPanel matched={pending} t={t} />}
  </section>
}
