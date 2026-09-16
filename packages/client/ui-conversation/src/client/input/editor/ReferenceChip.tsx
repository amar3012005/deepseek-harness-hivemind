/**
 * Visual body of one inline reference chip: the DecoratorNode's React
 * face. Pure display — identity, invalidation, and lifecycle live on the
 * ReferenceChipNode; this component renders whatever the node carries.
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { ReferenceIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReferenceIconKind } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ReferenceChip.module.css'

/** Display inputs of one chip (the node's cached owner projections). */
export interface ReferenceChipProps {
  readonly label: string
  /** Domain glyph; absent renders the trigger marker instead of an icon. */
  readonly appearance?: ReferenceIconKind | undefined
  readonly logoUrl?: string | undefined
  /** Owner-resolution failure styling bit. */
  readonly invalid: boolean
}

/**
 * Render one inline reference chip.
 * @param props - label, optional domain glyph, and the invalid bit.
 * @returns the chip body (icon + truncating label).
 */
function safeLogoUrl(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

export function ReferenceChip({ label, appearance, logoUrl, invalid }: ReferenceChipProps): ReactNode {
  const logo = safeLogoUrl(logoUrl)
  return (
    <span className={clsx(css.chip, invalid && css.invalid)} title={label}>
      {logo !== undefined
        ? <img className={css.logo} src={logo} alt="" />
        : appearance === undefined
          ? <span className={css.marker} aria-hidden>@</span>
          : <ReferenceIcon kind={appearance} size={14} className={css.icon} />}
      <span className={css.label}>{label}</span>
    </span>
  )
}
