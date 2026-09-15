import css from './ConnectorChips.module.css'

/** Compact, release-owned suggestions. They never imply an active connection
 * and deliberately avoid loading provider metadata before the user asks. */
const POPULAR_CONNECTORS = ['Gmail', 'Google Calendar', 'Google Drive', 'LinkedIn'] as const

export interface ConnectorChipsProps {
  insertMention: (app: string) => void
  visible?: boolean
}

/** Insert a connector mention into the native composer without executing it. */
export function ConnectorChips({ insertMention, visible = true }: ConnectorChipsProps) {
  if (!visible) return null
  return <div className={css.root} aria-label="Suggested connectors">
    {POPULAR_CONNECTORS.map(app => <button
      key={app}
      type="button"
      className={css.chip}
      onClick={() => { insertMention(app) }}
    >{app}</button>)}
  </div>
}
