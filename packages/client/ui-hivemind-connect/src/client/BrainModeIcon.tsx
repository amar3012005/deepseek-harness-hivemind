import { useId } from 'react'

export function BrainModeIcon({ size = 32 }: { size?: number }) {
  const id = useId().replace(/:/g, '')
  return <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label="Brain">
    <defs>
      <linearGradient id={`${id}-shade`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#e7dcf0"/><stop offset="0.5" stopColor="#b3a4c5"/><stop offset="1" stopColor="#756686"/></linearGradient>
      <pattern id={`${id}-weave`} width="2" height="2" patternUnits="userSpaceOnUse"><path d="M0 0H2M0 0V2" stroke="#fff" strokeOpacity=".22" strokeWidth=".45"/></pattern>
      <clipPath id={`${id}-shape`}><path d="M20 9C15 3 8 7 9 12C3 13 3 20 6 23C3 29 8 34 13 32C15 37 20 34 20 31C20 34 25 37 27 32C32 34 37 29 34 23C37 20 37 13 31 12C32 7 25 3 20 9Z"/></clipPath>
    </defs>
    <ellipse cx="20" cy="35" rx="12" ry="2" fill="#44354d" opacity=".12"/>
    <g clipPath={`url(#${id}-shape)`}><rect x="3" y="4" width="34" height="32" fill={`url(#${id}-shade)`}/><rect x="3" y="4" width="34" height="32" fill={`url(#${id}-weave)`}/></g>
    <path d="M20 10V31M13 12C12 17 17 16 16 21M9 22C14 19 15 26 12 28M27 12C28 17 23 16 24 21M31 22C26 19 25 26 28 28" fill="none" stroke="#695977" strokeWidth="1.5" strokeLinecap="round" opacity=".65"/>
  </svg>
}
