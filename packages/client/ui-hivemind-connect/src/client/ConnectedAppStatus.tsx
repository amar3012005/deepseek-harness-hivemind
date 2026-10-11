import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ConnectionAuthorizationPanel.module.css'

export interface AppStatus { app: string; toolkit: string; status: 'searching' | 'connecting' | 'working' }
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}
function toolkit(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,99}$/i.test(value) ? value.toLowerCase() : undefined
}
function callStatus(data: Record<string, unknown>): AppStatus | undefined {
  const name = data['name']
  if (name !== 'hivemind_connected_task' && !(typeof name === 'string' && name.startsWith('mcp__composio__'))) return undefined
  let args = object(data['args'])
  const serialized = data['arguments'] ?? data['argsRaw']
  if (!args && typeof serialized === 'string') { try { args = object(JSON.parse(serialized)) } catch {} }
  if (!args) return undefined
  const queries = Array.isArray(args['queries']) ? args['queries'] : []
  const apps = Array.isArray(args['apps']) ? args['apps'] : []
  const toolkits = Array.isArray(args['toolkits']) ? args['toolkits'] : []
  const slug = typeof args['tool_slug'] === 'string' ? args['tool_slug'].split('_')[0] : undefined
  const rawApp = object(queries[0])?.['app'] ?? apps[0] ?? toolkits[0] ?? slug
  const appToolkit = toolkit(rawApp)
  if (!appToolkit) return undefined
  const action = args['action']
  const status = action === 'search' || name === 'mcp__composio__COMPOSIO_SEARCH_TOOLS' ? 'searching'
    : action === 'manage_connection' || action === 'wait_connection' || name === 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS' ? 'connecting' : 'working'
  return { toolkit: appToolkit, app: appToolkit.charAt(0).toUpperCase() + appToolkit.slice(1), status }
}
/** Only actual unsettled native calls produce progress. Receipts never imply completion or connection. */
export function connectedAppStatus(window: SessionEventWindow, turn: number): AppStatus | undefined {
  let current: number | undefined
  const pending = new Map<string, AppStatus>()
  for (const entry of window.entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'turn/start') { current = event.data.turn; pending.clear() }
    if (current !== turn) continue
    if (event.type === 'turn/end') { pending.clear(); current = undefined }
    else if (event.type === 'tool/call') {
      const status = callStatus(event.data as unknown as Record<string, unknown>)
      if (status) pending.set(String(event.data.callId), status)
    } else if (event.type === 'tool/result') pending.delete(String(event.data.message.source.callId))
  }
  return [...pending.values()].at(-1)
}
export function ConnectedAppStatus({ turn, useEmployeeEvents, t }: PropsRuntime<'conversation.chat.workUpdates'>
  & PropsLocale<'hivemind-connect'> & { useEmployeeEvents: SnapshotSelectorHook<SessionEventWindow> }) {
  const status = useEmployeeEvents(window => connectedAppStatus(window, turn))
  if (!status) return null
  const label = status.status === 'searching' ? t('composio.searching')
    : status.status === 'connecting' ? t('composio.verifying') : t('composio.working')
  return <div className={css.appCard} role="status" aria-live="polite" data-connected-app-status>
    <img src={`https://logos.composio.dev/api/${encodeURIComponent(status.toolkit)}`} alt="" />
    <strong>{status.app}</strong><span>{label}</span>
  </div>
}
