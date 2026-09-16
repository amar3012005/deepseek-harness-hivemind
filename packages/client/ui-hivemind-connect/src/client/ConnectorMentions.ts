interface InputTriggerCandidate {
  name: string
  description?: string
  value?: string
  logoUrl?: string
  slug?: string
}

interface InputTriggerSource {
  trigger: '@'
  name: string
  order: number
  candidates(session: unknown, request: {
    query: string
    signal: AbortSignal
  }): Promise<readonly InputTriggerCandidate[]>
  onPick(input: { candidate: InputTriggerCandidate }): {
    insert: {
      source: string
      ref: string
      label: string
      clipboardText: string
      logoUrl?: string
    }
  } | { text: string } | undefined
}

interface Connector {
  slug: string
  name: string
  connected: boolean
  logo?: string
}

let catalogCache: { at: number; rows: Connector[] } = { at: 0, rows: [] }

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

function connectorRows(value: unknown): Connector[] {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { connectors?: unknown }).connectors)) return []
  return (value as { connectors: unknown[] }).connectors.flatMap((candidate): Connector[] => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const row = candidate as Record<string, unknown>
    if (typeof row.slug !== 'string' || typeof row.name !== 'string' || typeof row.connected !== 'boolean') return []
    const logo = safeHttpsUrl(row.logo)
    return [{ slug: row.slug, name: row.name, connected: row.connected, ...(logo === undefined ? {} : { logo }) }]
  })
}

export function cachedConnectorLogos(): Record<string, string> {
  const logos: Record<string, string> = {}
  for (const row of catalogCache.rows) {
    if (row.logo) logos[row.name] = row.logo
  }
  return logos
}

export async function loadConnectorCatalog(signal?: AbortSignal): Promise<readonly Connector[]> {
  if (Date.now() - catalogCache.at < 60_000 && catalogCache.rows.length > 0) return catalogCache.rows
  const response = await fetch('/api/hivemind/connectors?q=', { credentials: 'include', signal })
  if (!response.ok) return catalogCache.rows
  const rows = connectorRows(await response.json())
  catalogCache = { at: Date.now(), rows }
  return rows
}

export function createConnectorMentionSource(): InputTriggerSource {
  return {
    trigger: '@',
    name: 'connectors',
    order: 20,
    async candidates(_session, { query, signal }) {
      if (query.trim() === '') return []
      try {
        const response = await fetch(`/api/hivemind/connectors?q=${encodeURIComponent(query)}`, { credentials: 'include', signal })
        if (!response.ok || signal.aborted) return []
        const rows = connectorRows(await response.json())
        catalogCache = { at: Date.now(), rows: [...catalogCache.rows.filter(item => !rows.some(row => row.slug === item.slug)), ...rows] }
        return rows.map((item): InputTriggerCandidate => ({
          name: item.name,
          description: item.connected ? 'Connected app' : 'Available connector',
          value: item.slug,
          slug: item.slug,
          ...(item.logo === undefined ? {} : { logoUrl: item.logo }),
        }))
      } catch {
        return []
      }
    },
    onPick({ candidate }) {
      if (typeof candidate.value !== 'string' || typeof candidate.name !== 'string') return undefined
      return {
        insert: {
          source: 'connectors',
          ref: candidate.value,
          label: candidate.name,
          clipboardText: `@${candidate.name}`,
          ...(candidate.logoUrl === undefined ? {} : { logoUrl: candidate.logoUrl }),
        },
      }
    },
  }
}
