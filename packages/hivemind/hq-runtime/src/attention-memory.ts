/** Private Runtime decision context. Never copied to company Dreamer/Flashbacks. */
import { createHash } from 'node:crypto'
export interface AttentionMemoryRow {
  id: string
  kind: 'user_agenda' | 'uncertainty'
  title: string
  summary: string
  context: { state: string; priority: number; impact?: string; evidence?: string[]; agendaKey?: string; supersedesId?: string }
  created_at: Date | string
  total: string | number
}
export function attentionMemorySnapshot(rows: readonly AttentionMemoryRow[]) {
  const heads = rows.map(row => ({ id: row.id, kind: row.kind, title: row.title, summary: row.summary,
    state: row.context.state, priority: row.context.priority, impact: row.context.impact ?? '',
    evidence: row.context.evidence ?? [], agendaKey: row.context.agendaKey ?? '',
    supersedesId: row.context.supersedesId ?? '', createdAt: new Date(row.created_at).toISOString(), total: Number(row.total) }))
  if (heads.some(row => !Number.isInteger(row.priority) || row.priority < 0 || row.priority > 100
    || (row.kind === 'user_agenda' ? row.state !== 'confirmed' : row.state !== 'open'))) throw new Error('runtime_attention_memory_invalid')
  const seen = new Map<string, string>()
  let agendaConflict = false
  for (const row of heads.filter(row => row.kind === 'user_agenda' && row.agendaKey)) {
    const prior = seen.get(row.agendaKey)
    if (prior !== undefined && prior !== row.id) agendaConflict = true
    seen.set(row.agendaKey, row.id)
  }
  const revision = createHash('sha256').update(JSON.stringify(heads)).digest('hex')
  const project = (row: typeof heads[number]) => ({ ...row, summary: row.summary.slice(0, 600),
    impact: row.impact.slice(0, 300), evidence: row.evidence.slice(0, 3).map(value => value.slice(0, 180)) })
  return { revision, ready: !agendaConflict && !heads.some(row => row.total > 50), agendaConflict,
    userAgenda: heads.filter(row => row.kind === 'user_agenda').slice(0, 5).map(project),
    uncertainties: heads.filter(row => row.kind === 'uncertainty').slice(0, 5).map(project) }
}
export type AttentionDecisionMemory = ReturnType<typeof attentionMemorySnapshot>
