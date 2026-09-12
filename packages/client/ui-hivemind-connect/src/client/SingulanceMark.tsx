import type { SVGProps } from 'react'

const HERO_HEADLINE = 'Beyond Horizon Of Intelligence'

export interface SingulanceMarkProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number
}

/** The exact orbit-and-star Singulance mark used by the Da-vinci shell. */
export function SingulanceMark({ size = 24, className, ...props }: SingulanceMarkProps) {
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

/** Replace only the native new-session hero copy adjacent to this overlay's mark. */
export function setupSingulanceHeadline(): () => void {
  const originals = new Map<Element, string>()
  const apply = (): void => {
    for (const mark of document.querySelectorAll('[data-hivemind-hero-brand="singulance"]')) {
      const headline = mark.closest('span')?.nextElementSibling?.firstElementChild
      if (headline === undefined || headline === null || headline.textContent === HERO_HEADLINE) continue
      originals.set(headline, headline.textContent ?? '')
      headline.textContent = HERO_HEADLINE
    }
  }
  const observer = new MutationObserver(apply)
  observer.observe(document.body, { childList: true, subtree: true })
  apply()
  return () => {
    observer.disconnect()
    for (const [headline, original] of originals) {
      if (headline.isConnected && headline.textContent === HERO_HEADLINE) headline.textContent = original
    }
  }
}
