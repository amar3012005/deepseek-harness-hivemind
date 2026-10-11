import { useMemo } from 'react'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PendingConnectionAuthorization } from './connection-question.ts'
import { ConnectionAuthorizationPanel } from './ConnectionAuthorizationPanel.tsx'
import { savedConnectionRequests } from './connected-app-state.ts'

type Props = PropsRuntime<'conversation.input.dock'> & PropsLocale<'hivemind-connect'> & {
  useEmployeeEvents: SnapshotSelectorHook<SessionEventWindow>
  resume: (prompt: string) => Promise<void>
}
/** A persisted request is a dock item, never a foreground interaction or an implicit user response. */
export function ConnectedAppDock({ sessionId, useEmployeeEvents, resume, t, useSessionPendingInteraction }: Props) {
  const requests = useEmployeeEvents(savedConnectionRequests)
  const active = useSessionPendingInteraction(snapshot => snapshot.get(sessionId))
  const requestId = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('request')
  const request = requests.at(-1)
  const matched = useMemo(() => request === undefined ? null : ({
    key: `saved-connection-${request.callId}`,
    sessionId,
    question: { id: request.callId, question: request.reason },
    presentation: { version: 1 as const, appLabel: request.app, toolkit: request.toolkit,
      redirectUrl: request.redirect, logoUrl: request.logo,
      connectLabel: t('composio.connect', { app: request.app }),
      continueLabel: t('composio.continue', { app: request.app }) },
    continue: () => resume(`Check my ${request.app} connection and continue the paused request.`),
    cancel: () => resume(`Cancel the saved ${request.app} connection request with session_id ${JSON.stringify(request.workflow)} and request_call_id ${JSON.stringify(request.callId)}. Do not disconnect the account or resume the abandoned work.`),
  }), [request, sessionId, resume, t])
  if (matched === null || request === undefined || active instanceof PendingConnectionAuthorization) return null
  return <div data-connected-app-request={request.callId} data-request-highlighted={requestId === request.callId || undefined}>
    <ConnectionAuthorizationPanel key={matched.key} matched={matched} t={t} />
  </div>
}
