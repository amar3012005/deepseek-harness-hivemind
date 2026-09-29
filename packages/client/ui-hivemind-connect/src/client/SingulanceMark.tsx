import type { SVGProps } from 'react'
import { isHyperagentPreset } from './HyperagentEmployee.tsx'

const HERO_HEADLINE = 'BRAIN · Remember what matters.'
const HYPERAGENT_HEADLINE = "OS · Let's do the real work."

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

/** Replace the native headline with the current product's compact label. */
export function setupSingulanceHeadline(
  getPreset?: () => unknown,
  subscribe?: (refresh: () => void) => () => void,
): () => void {
  const originals = new Map<HTMLElement, string>()
  const apply = (): void => {
    if (typeof document === 'undefined') return
    const preset = getPreset?.()
    const hyperagent = isHyperagentPreset(preset)
      || (preset == null && window.location.pathname.startsWith('/hivemind/app/employee/harness/'))
    const desired = hyperagent ? HYPERAGENT_HEADLINE : HERO_HEADLINE
    for (const mark of document.querySelectorAll('[data-hivemind-hero-brand="singulance"]')) {
      const headline = mark.closest('span')?.parentElement
      const title = headline?.lastElementChild?.firstElementChild
      if (!(headline instanceof HTMLElement) || !(title instanceof HTMLElement)) continue
      if (!originals.has(title)) originals.set(title, title.textContent ?? '')
      if (title.textContent !== desired) title.textContent = desired
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
    for (const [title, original] of originals) {
      title.textContent = original
      title.closest('[data-hivemind-hero-headline]')?.removeAttribute('data-hivemind-hero-headline')
    }
  }
}
