import css from './HivemindRoomsCanvas.module.css'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HivemindConnectKey } from './locales.ts'

type CanvasCard = {
  readonly kind: 'folder' | 'file'
  readonly key: string
  readonly tone: 'blue' | 'mint' | 'violet' | 'amber' | 'coral' | 'red' | 'orange' | 'paper'
  readonly position: string
}

// These are intentionally visual prompts, not persisted workspace records.
// The native session log remains the only authority for actual files and work.
const CARDS: readonly CanvasCard[] = [
  { kind: 'folder', key: 'company', tone: 'blue', position: 'company' },
  { kind: 'folder', key: 'mission', tone: 'mint', position: 'mission' },
  { kind: 'folder', key: 'research', tone: 'violet', position: 'research' },
  { kind: 'folder', key: 'compliance', tone: 'amber', position: 'compliance' },
  { kind: 'folder', key: 'funnel', tone: 'coral', position: 'funnel' },
  { kind: 'folder', key: 'journey', tone: 'violet', position: 'journey' },
  { kind: 'file', key: 'report', tone: 'red', position: 'report' },
  { kind: 'file', key: 'deck', tone: 'orange', position: 'deck' },
  { kind: 'folder', key: 'assets', tone: 'blue', position: 'assets' },
  { kind: 'file', key: 'roadmap', tone: 'paper', position: 'roadmap' },
]

function Glyph({ kind, tone, t }: Pick<CanvasCard, 'kind' | 'tone'> & PropsLocale<'hivemind-connect'>) {
  if (kind === 'folder') return <span className={`${css.folder} ${css[tone]}`} aria-hidden />
  return <span className={`${css.file} ${css[tone]}`} aria-hidden><span>{t(tone === 'red' ? 'rooms.file.pdf' : tone === 'orange' ? 'rooms.file.ppt' : 'rooms.file.generic')}</span></span>
}

/** Decorative HIVE workspace canvas shown only by the native blank-session Hero. */
export function HivemindRoomsCanvas({ t }: PropsLocale<'hivemind-connect'>) {
  return <div className={css.canvas} aria-hidden="true" data-hivemind-rooms-canvas="">
    {CARDS.map(card => <article key={card.key} className={`${css.card} ${css[card.position]}`}>
      <div className={css.topline}>
        <Glyph kind={card.kind} tone={card.tone} t={t} />
        <div className={css.titleBlock}>
          <strong>{t(`rooms.${card.key}.title` as HivemindConnectKey)}</strong>
          <span>{t(`rooms.${card.key}.meta` as HivemindConnectKey)}</span>
        </div>
        <span className={css.more}>•••</span>
      </div>
      <p>{t(`rooms.${card.key}.detail` as HivemindConnectKey)}</p>
    </article>)}
  </div>
}
