/** Safe presentation of a connected-app update; admission is not consumption. */
export interface RuntimeSignal {
  readonly eventId: string
  readonly summary: string
  readonly action: 'notify' | 'wake'
  readonly appName: string
  readonly logoUrl?: string
}

type SignalContent = readonly { readonly type: string; readonly text?: string }[]

/** Read only the admitted app and evidence, including historical prefixed envelopes. */
export function runtimeSignalEvidence(content: SignalContent = []): { app?: string; title?: string; preview?: string } {
  const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
  if (text.length > 12_000) return {}
  try {
    const start = text.indexOf('\n{')
    const envelope = JSON.parse(text.trimStart().startsWith('{') ? text : start < 0 ? '' : text.slice(start + 1)) as {
      app?: unknown
      evidence?: { title?: unknown; preview?: unknown }
    }
    return {
      ...(typeof envelope?.app === 'string' ? { app: envelope.app } : {}),
      ...(typeof envelope?.evidence?.title === 'string' ? { title: envelope.evidence.title } : {}),
      ...(typeof envelope?.evidence?.preview === 'string' ? { preview: envelope.evidence.preview } : {}),
    }
  } catch { return {} }
}

const appNames: Record<string, string> = {
  slack: 'Slack', gmail: 'Gmail', googlecalendar: 'Google Calendar', googledrive: 'Google Drive',
  googlesheets: 'Google Sheets', notion: 'Notion', github: 'GitHub', outlook: 'Outlook',
  microsoftteams: 'Microsoft Teams', dreaming: 'Dreaming', dreamer: 'Dreaming',
}

function visibleSummary(value: string | undefined): string | undefined {
  if (!value || /^[\s]*[\[{]/u.test(value)) return undefined
  const text = value.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, 'reference')
    .replace(/\s+/gu, ' ').trim()
  return text ? text.length > 220 ? `${text.slice(0, 219).trimEnd()}…` : text : undefined
}

export function runtimeSignal(source: unknown, content?: SignalContent): RuntimeSignal | null {
  if (typeof source !== 'object' || source === null) return null
  const value = source as Record<string, unknown>
  if (value.kind !== 'hivemind-runtime-event' || typeof value.eventId !== 'string' || !value.eventId) return null
  const evidence = runtimeSignalEvidence(content)
  const legacyApp = typeof value.summary === 'string' ? /^(.*?) update$/iu.exec(value.summary)?.[1] : undefined
  const slug = (evidence.app ?? legacyApp ?? '').toLowerCase().replace(/[\s-]/gu, '')
  const isAppSlug = /^[a-z][a-z0-9_]{0,35}$/u.test(slug) && !/^[a-f0-9]{20,}$/u.test(slug)
  const appName = appNames[slug] ?? (isAppSlug
    ? `${slug.slice(0, 1).toUpperCase()}${slug.slice(1).replaceAll('_', ' ')}` : 'Connected app')
  const isAppSummary = typeof value.summary === 'string' && / update$/iu.test(value.summary)
  return {
    eventId: value.eventId,
    summary: visibleSummary(evidence.preview) ?? visibleSummary(evidence.title)
      ?? (!isAppSummary && typeof value.summary === 'string' ? visibleSummary(value.summary) : undefined)
      ?? 'New activity from this app',
    action: value.action === 'notify' ? 'notify' : 'wake',
    appName,
    ...(!['dreaming', 'dreamer'].includes(slug) && isAppSlug
      ? { logoUrl: `https://logos.composio.dev/api/${slug}` } : {}),
  }
}

/** Hide an admission echo once its durable consumed message is visible. */
export function pendingRuntimeSignals(
  queue: readonly { readonly source?: unknown; readonly content?: SignalContent }[],
  consumed: ReadonlySet<string>,
): readonly RuntimeSignal[] {
  const seen = new Set(consumed)
  return queue.flatMap((item) => {
    const signal = runtimeSignal(item.source, item.content)
    if (signal === null || seen.has(signal.eventId)) return []
    seen.add(signal.eventId)
    return [signal]
  })
}
