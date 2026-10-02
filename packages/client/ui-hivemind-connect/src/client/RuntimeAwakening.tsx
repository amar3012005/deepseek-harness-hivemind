/** Read-only progressive investigation cards over the native durable room log. */
import { useSyncExternalStore } from 'react'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { EmployeeAvatar } from './HyperagentEmployee.tsx'
import css from './RuntimeAwakening.module.css'
interface EventSource { subscribe(listener: () => void): () => void; getSnapshot(): SessionEventWindow }
interface Checkpoint {
  stage: string
  turn: number
  summary: string
  blocked: boolean
  cards: Array<{
    title: string
    detail: string
    image?: string
    reference?: string
    employeeId?: string
    role?: string
    avatarUrl?: string
  }>
}
const titles: Record<string, string> = { company: 'Understanding your company', evidence: 'Inspecting the evidence', team: 'Getting to know your team', memory: 'Learning from previous work', strategy: 'Building the initial strategy', conversation: 'Discussing your next agenda', remembered: 'Ready to continue' }
export function RuntimeAwakening({ events, turn }: { events: EventSource; turn: number }) {
  const window = useSyncExternalStore(listener => events.subscribe(listener), () => events.getSnapshot())
  const checkpoints = window.entries.flatMap((entry) => {
    if (entry.type !== 'event' || String(entry.event.type) !== 'hivemind/hq-awakening-checkpoint') return []
    const item = entry.event.data as unknown as Checkpoint
    return item.turn === turn ? [{ ...item, seq: entry.event.seq }] : []
  })
  if (!checkpoints.length) return null
  const stages = checkpoints.filter((item, index) => checkpoints.findIndex(other => other.stage === item.stage) === index)
    .map(item => ({ ...item, cards: checkpoints.filter(other => other.stage === item.stage).flatMap(other => other.cards) }))
  return <section className={css.root} aria-label="Runtime investigation">
    {stages.map(item => <section key={item.seq} className={css.stage}>
      <header><strong>{titles[item.stage] ?? item.stage}</strong>{item.blocked && <span>Needs attention</span>}</header>
      <p>{item.summary}</p>
      {item.cards.length > 0 && <div className={css.cards} role="list" aria-label={titles[item.stage]}>
        {item.cards.map((card, index) => <article key={`${item.seq}-${index}`} className={css.card} role="listitem">
          {card.employeeId && <EmployeeAvatar employee={{ id: card.employeeId, name: card.title, role: card.role ?? 'communicator', ...(card.avatarUrl ? { avatarUrl: card.avatarUrl } : {}) }} size={52} />}
          {card.image && <img src={card.image} alt={card.title} loading="lazy" />}
          <strong>{card.title}</strong><p>{card.detail}</p>
          {card.reference && <small>{card.reference}</small>}
        </article>)}
      </div>}
    </section>)}
  </section>
}
