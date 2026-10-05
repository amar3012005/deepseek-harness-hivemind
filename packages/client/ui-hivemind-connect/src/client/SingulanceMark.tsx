import { useSyncExternalStore, type SVGProps } from 'react'
import { EmployeeAvatar, RuntimeAvatar } from './HyperagentEmployee.tsx'
import type { RoomIdentity } from './room-identity.ts'

export interface SingulanceMarkProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number
}

/** The exact orbit-and-star Singulance mark used by the Da-vinci shell. */
export function SingulanceMark({ size = 48, className, ...props }: SingulanceMarkProps) {
  return <svg
    width={size}
    height={size}
    viewBox="-6 -6 112 112"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    data-hivemind-hero-brand="singulance"
    aria-hidden="true"
    {...props}
  >
    <ellipse
      cx="50" cy="50" rx="40" ry="13"
      transform="rotate(-18 50 50)"
      stroke="#0a0a0a"
      strokeWidth="3.2"
    />
    <circle cx="88.04" cy="37.64" r="4.4" fill="#0a0a0a" />
    <path
      d="M80,50 57.39,53.06 62.73,62.73 53.06,57.39 50,96 46.94,57.39 37.27,62.73 42.61,53.06 20,50 42.61,46.94 37.27,37.27 46.94,42.61 50,4 53.06,42.61 62.73,37.27 57.39,46.94 Z"
      fill="#22d3ee"
    />
  </svg>
}

/** Keep the first-entry portrait bound to the same native room summary as its title. */
export function RoomHeroMark({ size = 34, className, identity }: {
  size?: number | undefined
  className?: string | undefined
  identity: { getSnapshot(): string; subscribe(listener: () => void): () => void }
}) {
  const encoded = useSyncExternalStore(identity.subscribe, identity.getSnapshot)
  const value = JSON.parse(encoded) as RoomIdentity | null
  return value === null ? <SingulanceMark size={size} className={className} />
    : <span className={className} data-hivemind-hero-brand="singulance" aria-label={`${value.name}, ${value.role}`}>
      {value.employee ? <EmployeeAvatar employee={value.employee} size={size} /> : <RuntimeAvatar size={size} />}
    </span>
}

/** Keep the composer free of introductory slogans; identity lives in the environment. */
export function setupSingulanceHeadline(
  _getPreset?: () => unknown,
  subscribe?: (refresh: () => void) => () => void,
  _getIdentity?: () => RoomIdentity | undefined,
): () => void {
  const originals = new Map<HTMLElement, string>()
  const apply = (): void => {
    if (typeof document === 'undefined') return
    for (const mark of document.querySelectorAll('[data-hivemind-hero-brand="singulance"]')) {
      const headline = mark.closest('div')
      if (!(headline instanceof HTMLElement)) continue
      if (!originals.has(headline)) originals.set(headline, headline.style.display)
      headline.style.display = 'none'
      headline.setAttribute('data-hivemind-hero-headline', '')
    }
  }
  const observer = new MutationObserver(apply)
  observer.observe(document.body, { childList: true, subtree: true })
  const unsubscribe = subscribe?.(apply)
  apply()
  return () => {
    unsubscribe?.()
    observer.disconnect()
    for (const [headline, display] of originals) {
      headline.style.display = display
      headline.removeAttribute('data-hivemind-hero-headline')
    }
  }
}
