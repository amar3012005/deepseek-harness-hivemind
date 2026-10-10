/** Display only: never replace the full durable mailbox message or claim completion. */
export function briefAgentMessage(message: { summary?: unknown; text?: unknown; senderName?: unknown }): string | undefined {
  const brief = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
    && value.length <= 240 && !/[\r\n]/u.test(value)
  if (brief(message.summary)) return message.summary.trim()
  if (!brief(message.text)) return undefined
  const text = typeof message.senderName === 'string' && message.text.startsWith(`${message.senderName}:`)
    ? message.text.slice(message.senderName.length + 1).trimStart() : message.text
  return text.trim() ? text : undefined
}
