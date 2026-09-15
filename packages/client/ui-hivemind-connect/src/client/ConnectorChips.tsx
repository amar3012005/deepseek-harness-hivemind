import css from './ConnectorChips.module.css'

/** Compact, release-owned suggestions. They never imply an active connection
 * and deliberately avoid loading provider metadata before the user asks. */
const POPULAR_CONNECTORS = [
  { name: 'Gmail', slug: 'gmail' },
  { name: 'Google Calendar', slug: 'googlecalendar' },
  { name: 'Google Drive', slug: 'googledrive' },
  { name: 'LinkedIn', slug: 'linkedin' },
] as const

export interface ConnectorChipsProps {
  insertMention: (app: string) => void
  visible?: boolean
}

/** Insert a connector mention into the native composer without executing it. */
export function ConnectorChips({ insertMention, visible = true }: ConnectorChipsProps) {
  if (!visible) return null
  return <div className={css.root} aria-label="Suggested connectors">
    {POPULAR_CONNECTORS.map(app => <button
      key={app.slug}
      type="button"
      className={css.chip}
      onClick={() => { insertMention(app.name) }}
    ><img src={`https://logos.composio.dev/api/${app.slug}`} alt="" referrerPolicy="no-referrer" />{app.name}</button>)}
  </div>
}
