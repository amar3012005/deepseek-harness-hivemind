/** Saved operating receipts supplement document review without treating prose as completion. */
import type { LedgerEvent } from './ledger.ts'
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
/** Validate exact producer identity, task reference and successful save/delivery receipts. */
export function savedOperatingEvidence(
  producer: readonly LedgerEvent[],
  inbox: readonly LedgerEvent[],
  identity: { sessionId: string; employeeId: string; taskId: string; artifactIds: readonly string[] },
) {
  const owner = producer.find(event => event.type === 'hivemind/session-owner')
  const author = record(owner?.data)
  if (author?.['id'] !== identity.employeeId || typeof author['slug'] !== 'string') return { memories: [], replies: [], activity: [] }
  const taskMention = (text: string) => [...text.matchAll(/(?:^|[^a-z0-9_-])(task-[1-9]\d*)(?=$|[^a-z0-9_-])/gi)]
    .some(match => match[1] === identity.taskId)
  const memories: { id: string; kind: string; agentSlug: string; summary: string }[] = []
  for (const event of producer) {
    if (event.type !== 'tool/result') continue
    const content = record(record(event.data)?.['message'])?.['content']
    if (!Array.isArray(content)) continue
    for (const value of content) {
      const block = record(value)
      if (block?.['type'] !== 'tool-result' || block['isError'] === true || !Array.isArray(block['content'])) continue
      const call = producer.findLast(item => item.type === 'tool/call' && record(item.data)?.['callId'] === block['toolCallId'])
      if (record(call?.data)?.['name'] !== 'hyperagents_memory') continue
      let args: Record<string, unknown> | undefined
      try { args = record(JSON.parse(String(record(call?.data)?.['arguments']))) } catch { continue }
      if (args?.['action'] !== 'save' || !['learning', 'decision_note', 'handoff'].includes(String(args['kind']))) continue
      for (const item of block['content']) {
        const text = record(item)?.['text']
        if (typeof text !== 'string') continue
        try {
          const result = record(JSON.parse(text)), memory = record(result?.['memory'])
          if (result?.['ok'] !== true || typeof memory?.['id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memory['id']) || memory['agentSlug'] !== author['slug'] || memory['status'] !== 'recorded' || memory['kind'] !== args['kind'] || typeof memory['summary'] !== 'string' || memory['summary'] !== args['summary'] || !taskMention(memory['summary'])) continue
          memories.push({ id: memory['id'], kind: String(memory['kind']), agentSlug: author['slug'], summary: memory['summary'].slice(0, 2400) })
        } catch { /* Invalid output supplies no saved evidence. */ }
      }
    }
  }
  const replies = inbox.flatMap((event) => {
    const value = record(event.data)
    if (event.type !== 'hivemind/room-message-received' || typeof value?.['id'] !== 'string' || value['senderId'] !== identity.sessionId || value['taskId'] !== identity.taskId || !['update', 'reply'].includes(String(value['kind'])) || !Array.isArray(value['artifactIds']) || !value['artifactIds'].some(id => identity.artifactIds.includes(String(id))) || typeof value['text'] !== 'string') return []
    return [{ messageId: value['id'], senderSessionId: identity.sessionId, taskId: identity.taskId, artifactIds: value['artifactIds'].filter(id => typeof id === 'string' && identity.artifactIds.includes(id)).map(String), text: value['text'].slice(0, 2400) }]
  })
  const activity = identity.artifactIds.flatMap((artifactId) => {
    const artifact = producer.findLast(event => ['hivemind/artifact-created', 'hivemind/generation-created'].includes(event.type) && record(event.data)?.['artifactId'] === artifactId)
    if (artifact?.seq === undefined) return []
    const artifactSeq = artifact.seq
    const start = producer.findLast(event => event.type === 'turn/start' && event.seq !== undefined && event.seq < artifactSeq)
    const turn = record(start?.data)?.['turn']
    const end = producer.find(event => event.type === 'turn/end' && event.seq !== undefined && event.seq > artifactSeq && record(event.data)?.['turn'] === turn)
    if (start?.seq === undefined || end?.seq === undefined || typeof turn !== 'number') return []
    const startSeq = start.seq, endSeq = end.seq
    const scoped = producer.filter(event => event.seq !== undefined && event.seq > startSeq && event.seq < endSeq)
    const calls = scoped.filter(event => event.type === 'tool/call')
    return [{ artifactId, producerSessionId: identity.sessionId, turn, startSeq: start.seq, endSeq: end.seq, truncated: calls.length > 64,
      tools: calls.slice(0, 64).flatMap((call) => {
        const data = record(call.data)
        if (call.seq === undefined || typeof data?.['name'] !== 'string' || typeof data['callId'] !== 'string') return []
        const results = scoped.flatMap((event) => {
          const content = record(record(event.data)?.['message'])?.['content']
          if (event.seq === undefined || event.type !== 'tool/result' || !Array.isArray(content)) return []
          const resultSeq = event.seq
          return content.flatMap((item) => { const block = record(item); return block?.['type'] === 'tool-result' && block['toolCallId'] === data['callId'] ? [{ resultSeq, outcome: block['isError'] === true ? 'error' : 'success' }] : [] })
        })
        return [{ name: data['name'].slice(0, 180), callSeq: call.seq, results }]
      }),
      interpretation: 'Observed tool receipts in the saved artifact-producing turn. This does not establish absence of actions outside this turn or success beyond the recorded tool results.',
    }]
  })
  return { memories: memories.slice(-12), replies: replies.slice(-12), activity }

}
