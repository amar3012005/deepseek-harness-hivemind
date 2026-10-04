/** Read-only progressive investigation cards over the native durable room log. */
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { useState, useSyncExternalStore } from 'react'
import { DisclosureRow, IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { EmployeeAvatar } from './HyperagentEmployee.tsx'
import css from './RuntimeAwakening.module.css'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'conversation.chat.workUpdates': { kind: 'list'; scope: 'session'; owner: { turn: number } }; 'hivemind.runtime.plan': { kind: 'list'; scope: 'session'; owner: { turn: number } } }
}
interface EventSource { subscribe(listener: () => void): () => void; getSnapshot(): SessionEventWindow }
export interface Checkpoint {
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
const titles: Record<string, string> = { company: 'Understanding our company', evidence: 'Inspecting our evidence', team: 'Getting to know our team', memory: 'Learning from previous work', strategy: 'Awakening Plan', conversation: 'Discussing your next agenda', remembered: 'Ready to continue' }
export function RuntimeAwakening(
  { events, turn, checkpointSeq, openArtifact }: {
    events: EventSource
    turn: number
    checkpointSeq?: number
    openArtifact?: (artifactId: string) => void
  }
    & Pick<PropsRenderSlots<'hivemind.runtime.plan'>, 'renderSlot'>,
) {
  const window = useSyncExternalStore(listener => events.subscribe(listener), () => events.getSnapshot())
  const previous = new Map<string, string>()
  const seenCards = new Set<string>()
  const checkpoints = window.entries.flatMap((entry) => {
    if (entry.type !== 'event' || String(entry.event.type) !== 'hivemind/hq-awakening-checkpoint') return []
    const item = entry.event.data as unknown as Checkpoint
    if (item.turn !== turn) return []
    const fingerprint = JSON.stringify([item.summary, item.blocked, item.cards])
    const unchanged = previous.get(item.stage) === fingerprint
    previous.set(item.stage, fingerprint)
    const cards = item.cards.filter((card) => {
      const key = JSON.stringify(card)
      if (seenCards.has(key)) return false
      seenCards.add(key)
      return true
    })
    return !unchanged && (checkpointSeq === undefined || entry.event.seq === checkpointSeq)
      ? [{ ...item, cards, seq: entry.event.seq }] : []
  })
  if (!checkpoints.length) return null
  const stages = checkpoints.map((item) => {
    const redundant = item.cards.length === 1 && item.cards[0]?.detail === item.summary
      && !item.cards[0]?.image && !item.cards[0]?.employeeId && !item.cards[0]?.reference
    return { ...item, cards: redundant && item.stage !== 'strategy' ? [] : item.cards }
  })
  return <section className={css.root} aria-label="Runtime investigation">
    {stages.map(item => <section key={item.seq} className={css.stage}>
      <header><strong>{titles[item.stage] ?? item.stage}</strong>{item.blocked && <span>Needs attention</span>}</header>
      <p>{item.summary}</p>
      {item.stage === 'strategy' && item.cards.filter(card => card.reference || (card.title && card.title !== item.summary))
        .map((card, index) => <div key={index} className={css.planTitle}><strong>{card.title}</strong>
          {card.reference && window.entries.some(entry => entry.type === 'event'
            && ['hivemind/generation-created', 'hivemind/artifact-created'].includes(String(entry.event.type))
            && (entry.event.data as unknown as { artifactId?: string }).artifactId === card.reference)
            && openArtifact && <button type="button" className={css.planOpen} onClick={() => { openArtifact(card.reference ?? '') }}>Open plan</button>}
        </div>)}
      {item.cards.length > 0 && <CheckpointDetails cards={item.cards} />}
    </section>)}
  </section>
}

/** Optional receipt/persona detail uses the same native collapsed chrome as tool work. */
function CheckpointDetails({ cards }: { cards: Checkpoint['cards'] }) {
  const [open, setOpen] = useState(false)
  return <>
    {cards.some(card => card.employeeId) && <div className={css.team} role="list" aria-label="Your team">
      {cards.filter(card => card.employeeId).map(card => <article key={card.employeeId} className={css.employee} role="listitem">
        <EmployeeAvatar employee={{ id: card.employeeId ?? '', name: card.title, role: card.role ?? 'communicator',
          ...(card.avatarUrl ? { avatarUrl: card.avatarUrl } : {}) }} size={36} />
        <div><strong>{card.title}</strong>{card.role && <small>{card.role}</small>}</div>
      </article>)}
    </div>}
    {cards.filter(card => card.image).map((card, index) => <img key={index} className={css.evidenceImage}
      src={card.image} alt={card.title} loading="lazy" />)}
    <DisclosureRow title="Work details" icon={<IconBrowseOutline16 size={14} />} open={open}
      expandable expandOnRowClick onToggle={() => { setOpen(value => !value) }}>
      <div className={css.cards} role="list">
        {cards.map((card, index) => <article key={index} className={css.card} role="listitem">
          {card.employeeId && <EmployeeAvatar employee={{ id: card.employeeId, name: card.title,
            role: card.role ?? 'communicator', ...(card.avatarUrl ? { avatarUrl: card.avatarUrl } : {}) }} size={32} />}
          <strong>{card.title}</strong><p>{card.detail}</p>
          {card.reference && <small>{card.reference}</small>}
        </article>)}
      </div>
    </DisclosureRow>
  </>
}
