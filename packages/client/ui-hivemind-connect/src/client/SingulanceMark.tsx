import type { SVGProps } from 'react'
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

/** Use the shared company mark above first-entry agent composers. */
export function RoomHeroMark({ size = 34, className, identity }: {
  size?: number | undefined
  className?: string | undefined
  identity: { getSnapshot(): string; subscribe(listener: () => void): () => void }
}) {
  void identity
  return <SingulanceMark size={size} className={className} />
}

/** Show the requested welcome only in the native empty-room hero. */
export function setupSingulanceHeadline(
  getPreset?: () => unknown,
  subscribe?: (refresh: () => void) => () => void,
  getIdentity?: () => RoomIdentity | undefined,
): () => void {
  const originals = new Map<HTMLElement, { display: string; title: string }>()
  const apply = (): void => {
    if (typeof document === 'undefined') return
    for (const headline of document.querySelectorAll('[data-conversation-intro-headline]')) {
      if (!(headline instanceof HTMLElement)) continue
      const title = headline.lastElementChild?.firstElementChild
      if (!(title instanceof HTMLElement)) continue
      if (!originals.has(headline)) originals.set(headline, { display: headline.style.display, title: title.textContent ?? '' })
      const preset = getPreset?.()
      const identity = getIdentity?.()
      const runtime = preset === 'hivemind-hq' || identity?.name === 'Runtime'
      const agent = runtime || preset === 'hivemind-hyperagents' || identity?.employee !== undefined
      headline.style.display = originals.get(headline)?.display ?? ''
      if (!agent) {
        const original = originals.get(headline)
        if (original && title.textContent !== original.title) title.textContent = original.title
        headline.removeAttribute('data-hivemind-hero-headline')
        continue
      }
      const text = runtime ? 'RUNTIME : Lets Shape your company together' : 'Hyperagents : Lets do the real work.'
      if (agent && title.textContent !== text) title.textContent = text
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
    for (const [headline, original] of originals) {
      headline.style.display = original.display
      const title = headline.lastElementChild?.firstElementChild
      if (title instanceof HTMLElement) title.textContent = original.title
      headline.removeAttribute('data-hivemind-hero-headline')
    }
  }
}
