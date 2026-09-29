/**
 * Small HIVE-owned visual baseline for generated artifacts.
 *
 * This is deliberately not an external design runtime. A profile is selected
 * by a model-facing artifact tool, applied deterministically before local
 * rendering, and recorded in the durable artifact receipt. Future providers
 * may add licensed template assets behind the same profile names without
 * changing the tool contract.
 */
export const designProfiles = ['executive', 'editorial', 'campaign', 'product', 'data'] as const
export type DesignProfile = typeof designProfiles[number]

export interface DesignQuality {
  readonly status: 'ready' | 'needs_review'
  readonly checks: string[]
  readonly warnings: string[]
}

const profileCss: Record<DesignProfile, string> = {
  executive: `
    :root { --hm-ink:#102033; --hm-muted:#526477; --hm-paper:#f7f9fb; --hm-accent:#087e8b; --hm-line:#d9e2ea; --hm-display:Georgia, 'Times New Roman', serif; --hm-body:Inter, ui-sans-serif, system-ui, sans-serif; }
    body { background:var(--hm-paper); color:var(--hm-ink); font-family:var(--hm-body); line-height:1.55; text-rendering:optimizeLegibility; }
    h1,h2,h3 { font-family:var(--hm-display); letter-spacing:-.035em; line-height:1.05; }
    h1 { font-size:clamp(2.8rem,6vw,5.6rem); max-width:16ch; } h2 { font-size:clamp(1.7rem,3vw,3rem); }
    .eyebrow { color:var(--hm-accent); font-size:.72rem; font-weight:750; letter-spacing:.18em; text-transform:uppercase; }
    .card { border:1px solid var(--hm-line); background:#fff; border-radius:1rem; box-shadow:0 16px 42px rgba(16,32,51,.06); }
  `,
  editorial: `
    :root { --hm-ink:#151515; --hm-muted:#65615c; --hm-paper:#f4f0e8; --hm-accent:#bd3d2e; --hm-line:#d9d0c1; --hm-display:Georgia, 'Times New Roman', serif; --hm-body:Arial, Helvetica, sans-serif; }
    body { background:var(--hm-paper); color:var(--hm-ink); font-family:var(--hm-body); line-height:1.62; text-rendering:optimizeLegibility; }
    h1,h2,h3 { font-family:var(--hm-display); font-weight:500; letter-spacing:-.045em; line-height:.98; }
    h1 { font-size:clamp(3rem,8vw,7rem); max-width:13ch; } h2 { font-size:clamp(1.9rem,4vw,3.8rem); }
    .eyebrow { color:var(--hm-accent); font-size:.7rem; font-weight:700; letter-spacing:.2em; text-transform:uppercase; }
    .card { border-top:2px solid var(--hm-ink); background:rgba(255,255,255,.35); }
  `,
  campaign: `
    :root { --hm-ink:#091722; --hm-muted:#536370; --hm-paper:#edf5f7; --hm-accent:#e7683c; --hm-accent-2:#1b9aaa; --hm-line:#cfe0e5; --hm-display:Inter, ui-sans-serif, system-ui, sans-serif; --hm-body:Inter, ui-sans-serif, system-ui, sans-serif; }
    body { background:var(--hm-paper); color:var(--hm-ink); font-family:var(--hm-body); line-height:1.48; text-rendering:optimizeLegibility; }
    h1,h2,h3 { font-family:var(--hm-display); font-weight:800; letter-spacing:-.06em; line-height:.94; }
    h1 { font-size:clamp(3.1rem,8vw,7.5rem); max-width:12ch; } h2 { font-size:clamp(1.8rem,3.4vw,3.4rem); }
    .eyebrow { color:var(--hm-accent); font-size:.72rem; font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
    .card { border:1px solid var(--hm-line); background:#fff; border-radius:1.25rem; box-shadow:0 20px 56px rgba(9,23,34,.11); }
  `,
  product: `
    :root { --hm-ink:#13162b; --hm-muted:#62677f; --hm-paper:#f7f8ff; --hm-accent:#6857f5; --hm-accent-2:#18b99c; --hm-line:#dedff1; --hm-display:Inter, ui-sans-serif, system-ui, sans-serif; --hm-body:Inter, ui-sans-serif, system-ui, sans-serif; }
    body { background:var(--hm-paper); color:var(--hm-ink); font-family:var(--hm-body); line-height:1.5; text-rendering:optimizeLegibility; }
    h1,h2,h3 { font-family:var(--hm-display); font-weight:760; letter-spacing:-.055em; line-height:1; }
    h1 { font-size:clamp(2.8rem,6vw,6.2rem); max-width:15ch; } h2 { font-size:clamp(1.6rem,3vw,3rem); }
    .eyebrow { color:var(--hm-accent); font-size:.72rem; font-weight:800; letter-spacing:.14em; text-transform:uppercase; }
    .card { border:1px solid var(--hm-line); background:rgba(255,255,255,.92); border-radius:1rem; box-shadow:0 18px 50px rgba(32,25,102,.08); }
  `,
  data: `
    :root { --hm-ink:#102033; --hm-muted:#56697c; --hm-paper:#f5f8fa; --hm-accent:#126782; --hm-accent-2:#e18c32; --hm-line:#d5e1e8; --hm-display:Inter, ui-sans-serif, system-ui, sans-serif; --hm-body:Inter, ui-sans-serif, system-ui, sans-serif; }
    body { background:var(--hm-paper); color:var(--hm-ink); font-family:var(--hm-body); line-height:1.48; text-rendering:optimizeLegibility; }
    h1,h2,h3 { font-family:var(--hm-display); font-weight:740; letter-spacing:-.05em; line-height:1.02; }
    h1 { font-size:clamp(2.6rem,5vw,5.5rem); max-width:16ch; } h2 { font-size:clamp(1.5rem,2.6vw,2.6rem); }
    .eyebrow { color:var(--hm-accent); font-size:.7rem; font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
    .card { border:1px solid var(--hm-line); background:#fff; border-radius:.75rem; box-shadow:0 12px 30px rgba(16,32,51,.05); }
  `,
}

function has(pattern: RegExp, html: string): boolean { return pattern.test(html) }

/** Apply profile CSS before author CSS so an authored artifact can override it. */
export function applyDesignProfile(html: string, profile?: DesignProfile): string {
  if (profile === undefined) return html
  const style = `<style id="hivemind-design-profile">${profileCss[profile]}</style>`
  // The profile is a baseline, so authored CSS later in <head> wins naturally.
  if (has(/<head[^>]*>/i, html)) return html.replace(/<head[^>]*>/i, match => `${match}${style}`)
  if (has(/<html[^>]*>/i, html)) return html.replace(/<html[^>]*>/i, match => `${match}<head>${style}</head>`)
  return html
}

/** Deterministic checks complement—not substitute for—optional vision review. */
export function evaluateDesignQuality(html: string, profile?: DesignProfile): DesignQuality {
  const checks: string[] = ['complete_html', 'self_contained_render']
  const warnings: string[] = []
  if (profile !== undefined) checks.push(`profile:${profile}`)
  if (has(/<meta\s+name=["']viewport["']/i, html)) checks.push('responsive_viewport')
  else warnings.push('missing_responsive_viewport')
  if (has(/@media\s+print/i, html)) checks.push('print_styles')
  if (has(/<img\b/i, html) && has(/https?:\/\//i, html)) warnings.push('remote_image_may_not_render_in_isolated_preview')
  if (!has(/<h1\b/i, html)) warnings.push('missing_primary_heading')
  return { status: warnings.length === 0 ? 'ready' : 'needs_review', checks, warnings }
}
