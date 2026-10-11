import { createHash } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ApprovalRequestId } from './types.ts'
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
/** Bind the human decision to the exact native call arguments; never copy credentials into another event. */
export function approvalFingerprint(session: Session, callId: string, toolName: string): string | undefined {
  const call = session.snapshotEvents().findLast(event => event.type === 'tool/call' && event.data.callId === callId)
  if (call?.type !== 'tool/call' || call.data.name !== toolName) return
  try {
    const args = typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments
    return createHash('sha256').update(toolName + '\0' + canonical(args)).digest('hex')
  } catch { return undefined }
}
/** Only a server-admitted human answer, in this same session, can authorize one unchanged call. */
export function acceptedParkedApproval(
  session: Session, callId: string, toolName: string, fingerprint: string,
): ApprovalRequestId | undefined {
  const events = session.snapshotEvents()
  const current = events.findLast(event => event.type === 'tool/call' && event.data.callId === callId)
  if (!current) return
  for (const event of events.toReversed()) {
    if (event.type !== 'approval/asked' || event.data.toolName !== toolName || event.data.fingerprint !== fingerprint || !event.data.callId || event.seq >= current.seq) continue
    const id = event.data.id
    if (!events.some(value => value.type === 'approval/decided' && value.data.id === id && value.data.outcome === 'pending')
      || events.some(value => value.type === 'approval/consumed' && value.data.id === id)) continue
    const answer = events.findLast((value) => {
      if (value.type !== 'user/message' || value.seq <= event.seq || value.seq >= current.seq) return false
      const source = value.data.source as unknown as Record<string, unknown>
      return source['kind'] === 'user-question-reply' && source['callId'] === event.data.callId
        && source['outcome'] === 'answered' && source['questionAnswerSubmission'] === true
        && source['authenticatedActor'] !== null && typeof source['authenticatedActor'] === 'object'
    })
    if (answer?.type !== 'user/message') continue
    try {
      const batch = JSON.parse(answer.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
      const answers = batch.answers ?? batch
      if (Array.isArray(answers) && answers.length === 1 && answers[0].id === 'approval'
        && Array.isArray(answers[0].selected) && answers[0].selected.length === 1 && answers[0].selected[0] === 'Allow once' && !answers[0].custom) return id
    } catch { /* Natural-language assent and malformed answers never grant permission. */ }
  }
  return undefined
}
