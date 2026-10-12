import { cachedConnectorLogos } from './ConnectorMentions.ts'
import css from './ConnectorChips.module.css'

const POPULAR_CONNECTORS = ['Gmail', 'Google Calendar', 'Google Drive', 'LinkedIn'] as const

export interface ConnectorChipInsert {
  source: 'connectors'
  ref: string
  label: string
  clipboardText: string
  logoUrl?: string
}

export interface ConnectorChipsProps {
  insertMention: (chip: ConnectorChipInsert) => void
  visible?: boolean
}

export function ConnectorChips({ insertMention, visible = true }: ConnectorChipsProps) {
  if (!visible) return null
  const logos = cachedConnectorLogos()
  return <div className={css.root} aria-label="Suggested connectors">
    {POPULAR_CONNECTORS.map((app) => {
      const logo = logos[app]
      return <button
        key={app}
        type="button"
        className={css.chip}
        onClick={() => {
          insertMention({
            source: 'connectors',
            ref: app.toLowerCase().replaceAll(' ', ''),
            label: app,
            clipboardText: `@${app}`,
            ...(logo === undefined ? {} : { logoUrl: logo }),
          })
        }}
      >
        {logo ? <img className={css.logo} src={logo} alt="" /> : <span className={css.fallback} aria-hidden>@</span>}
        {app}
      </button>
    })}
  </div>
}
