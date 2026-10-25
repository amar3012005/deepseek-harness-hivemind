/** Approval detail in plain language: a connected app's logo and fields, or a shell command; never slugs or raw JSON. */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import { approvalCall } from './app-approval.ts'
import css from './ApprovalAppDetail.module.css'

interface ToolRoot { readonly callId?: string; readonly argsRaw?: string; readonly kind?: string }

/**
 * Render the call an approval is for, found among the session's running Tool rows.
 * @param props - Approval identity, Chat selector hook and HQ copy.
 * @returns The app card, the command text, or nothing while arguments are unreadable.
 */
/**
 * Read the raw arguments of an approval's call from the session's running Tool rows.
 * @param useChat - Chat selector hook.
 * @param callId - Call the approval is for.
 * @returns The streamed argument text, or undefined before the call row exists.
 */
function useApprovalArgs(useChat: PropsRuntime<'conversation.approval.detail'>['useChat'], callId: string): string | undefined {
  return useChat((snapshot) => {
    for (const node of snapshot.nodes.values()) {
      const root = node.kind === 'tool-call' ? (node.data as { readonly root?: ToolRoot }).root : undefined
      if (root !== undefined && root.callId === callId && !('kind' in root)) return root.argsRaw
    }
    return undefined
  })
}

/**
 * Render the call an approval is for, found among the session's running Tool rows.
 * @param props - Approval identity, Chat selector hook and HQ copy.
 * @returns The app card, the command text, or nothing while arguments are unreadable.
 */
export function ApprovalAppDetail({ callId, useChat, t }: PropsRuntime<'conversation.approval.detail'> & PropsLocale<'hivemind.hq'>) {
  const argsRaw = useApprovalArgs(useChat, callId)
  const [logoFailed, setLogoFailed] = useState(false)
  const call = approvalCall(argsRaw)
  if (call === undefined) return null
  if (call.kind === 'command') return call.command
  return <>
    <span className={css.app}>
      {!logoFailed && <img className={css.logo} src={`https://logos.composio.dev/api/${encodeURIComponent(call.toolkit)}`} alt="" onError={() => { setLogoFailed(true) }} />}
      {call.app}
    </span>
    {call.fields.length > 0 && <dl className={css.fields}>
      {call.fields.map((field, index) => <div key={index} className={css.row}>
        <dt>{field.labelKey ? t(field.labelKey) : field.label}</dt>
        <dd>{field.value}</dd>
      </div>)}
    </dl>}
  </>
}

const ACTION_LABELS = {
  'send-email': { 'allowed-once': 'approval.action.sendEmail', rejected: 'approval.action.discard' },
  'save-draft': { 'allowed-once': 'approval.action.saveDraft', rejected: 'approval.action.discard' },
} as const

/**
 * Name an approval decision by what it does for a known connected-app action, such as Send email or Discard.
 * @param props - Approval identity, decision, the approval owner's default label, and HQ copy.
 * @returns The action-named label, or the default label for any other call.
 */
export function ApprovalActionLabel({ callId, decision, fallback, useChat, t }: PropsRuntime<'conversation.approval.actionLabel'> & PropsLocale<'hivemind.hq'>) {
  const call = approvalCall(useApprovalArgs(useChat, callId))
  return call?.kind === 'app' && call.action !== undefined ? t(ACTION_LABELS[call.action][decision]) : fallback
}
