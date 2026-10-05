/** Presentation of the existing host-framed assignment; no prompt/model content changes. */
export function assignmentMessageText(message: {
  id?: unknown
  senderId?: unknown
  senderEmployee?: unknown
  taskId?: unknown
  kind?: unknown
  text?: unknown
}, source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const provenance = source as { kind?: unknown; messageId?: unknown; senderId?: unknown }
  if (provenance.kind !== 'hivemind-agent-message' || message.senderEmployee !== 'runtime'
    || message.kind !== 'question' || typeof message.taskId !== 'string' || typeof message.senderId !== 'string'
    || message.senderId !== provenance.senderId || message.id !== provenance.messageId || typeof message.id !== 'string'
    || typeof message.text !== 'string') return undefined
  // Exact native employeeWorkPrompt framing, not arbitrary prose matching.
  const [referenceLine, contractLine] = message.text.split('\n')
  const marker = 'HQ_EMPLOYEE_ASSIGNMENT='
  if (!referenceLine?.startsWith(marker) || contractLine === undefined) return undefined
  try {
    const reference = JSON.parse(referenceLine.slice(marker.length)) as { rootId?: unknown; taskId?: unknown }
    const contract = JSON.parse(contractLine) as { expectedOutcome?: unknown }
    if (reference?.rootId !== message.senderId || reference.taskId !== message.taskId
      || typeof contract?.expectedOutcome !== 'string' || !contract.expectedOutcome.trim()
      || contract.expectedOutcome.length > 500) return undefined
    return `I’ve assigned you this work: ${contract.expectedOutcome.trim()}`
  } catch { return undefined }
}
