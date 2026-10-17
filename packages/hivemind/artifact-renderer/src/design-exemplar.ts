/** Original, non-brand visual study. Shared artwork contains no tenant data. */
import { createCanvas } from '@napi-rs/canvas'
import { createHash } from 'node:crypto'

const palettes: Record<string, [string, string, string]> = {
  editorial: ['#f5efe2', '#272b28', '#ca542b'],
  presentation: ['#e9edf6', '#162840', '#426bd7'],
  illustration: ['#f4efd9', '#173f38', '#b75336'],
  marketing: ['#f7e9df', '#402432', '#d33e50'],
  minimal: ['#f5f5f0', '#222724', '#477560'],
}
const cache = new Map<string, { id: string; data: Uint8Array; sha256: string }>()

/** Render one packaged editorial study using the existing native canvas dependency. */
export function bundledDesignExemplar(purpose: string): { id: string; data: Uint8Array; sha256: string } {
  const key = Object.hasOwn(palettes, purpose) ? purpose : 'editorial'
  const prior = cache.get(key)
  if (prior) return prior
  const [paper, ink, accent] = palettes[key] ?? ['#f5efe2', '#272b28', '#ca542b']
  const canvas = createCanvas(1440, 1024); const ctx = canvas.getContext('2d')
  ctx.fillStyle = paper; ctx.fillRect(0, 0, 1440, 1024)
  const text = (value: string, x: number, y: number, size: number, color = ink, weight = 'normal') => {
    ctx.fillStyle = color; ctx.font = `${weight} ${size}px sans-serif`; ctx.fillText(value, x, y)
  }
  text('FIELDNOTES / VISUAL COMPOSITION STUDY', 70, 70, 17, ink, 'bold')
  text('01 — A clearer', 70, 200, 76, ink, 'bold')
  text('way forward.', 70, 290, 76, ink, 'bold')
  text('Start with a meaningful idea. Give it room.', 74, 360, 24)
  text('Evidence, illustration and deliberate hierarchy', 74, 400, 24)
  text('make a useful document feel considered.', 74, 438, 24)
  ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(70, 515); ctx.lineTo(1370, 515); ctx.stroke()
  // A focal illustration, rather than a grid of identical cards.
  ctx.strokeStyle = accent; ctx.lineWidth = 3
  for (let i = 0; i < 6; i++) {
    ctx.beginPath(); ctx.ellipse(1110, 275, 170, 50 + i * 18, i * .29, 0, Math.PI * 2); ctx.stroke()
  }
  ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(1110, 275, 24, 0, Math.PI * 2); ctx.fill()
  text('A', 75, 600, 24, accent, 'bold'); text('The signal', 130, 600, 33, ink, 'bold')
  text('Separate observed evidence', 130, 650, 22); text('from the interpretation.', 130, 684, 22)
  text('B', 745, 600, 24, accent, 'bold'); text('The next move', 800, 600, 33, ink, 'bold')
  text('Make the recommendation', 800, 650, 22); text('specific and easy to act on.', 800, 684, 22)
  ctx.fillStyle = ink; ctx.fillRect(70, 760, 1300, 162)
  text('Less decoration. More direction.', 105, 820, 36, paper, 'bold')
  text('Use visual rhythm, one strong illustration and a clear reading order.', 105, 870, 23, paper)
  text('ORIGINAL STYLE STUDY — NOT COMPANY BRAND DNA OR FACTUAL CONTENT', 70, 975, 16)
  const data = new Uint8Array(canvas.toBuffer('image/png'))
  const result = { id: `bundled-${key}-v1`, data, sha256: createHash('sha256').update(data).digest('hex') }
  cache.set(key, result)
  return result
}
