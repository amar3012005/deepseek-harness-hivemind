interface InputTriggerCandidate {
  name: string
  description?: string
  value?: string
  logo?: string
}

interface InputTriggerSource {
  trigger: '@'
  name: string
  order: number
  candidates(session: unknown, request: {
    query: string
    signal: AbortSignal
  }): Promise<readonly InputTriggerCandidate[]>
  onPick(input: { candidate: InputTriggerCandidate }): { text: string } | undefined
}

interface Connector {
  slug: string
  name: string
  connected: boolean
  logo?: string
}

function connectorRows(value: unknown): Connector[] {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { connectors?: unknown }).connectors)) return []
  return (value as { connectors: unknown[] }).connectors.flatMap((candidate): Connector[] => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const row = candidate as Record<string, unknown>
    const logo = typeof row.logo === 'string' && row.logo.startsWith('https://') ? row.logo : undefined
    return typeof row.slug === 'string' && typeof row.name === 'string' && typeof row.connected === 'boolean'
      ? [{ slug: row.slug, name: row.name, connected: row.connected, ...(logo === undefined ? {} : { logo }) }]
      : []
  })
}

/** A deliberately lazy @ source. It asks the authenticated runner only after
 * the user has started a connector mention; results remain plain text until
 * the normal connected-app workflow is selected by the model. */
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
        return connectorRows(await response.json()).map((item): InputTriggerCandidate => ({
          name: item.name,
          description: item.connected ? 'Connected app' : 'Available connector',
          value: item.name,
          ...(item.logo === undefined ? {} : { logo: item.logo }),
        }))
      } catch {
        return []
      }
    },
    onPick({ candidate }) {
      return typeof candidate.value === 'string' ? { text: `@${candidate.value} ` } : undefined
    },
  }
}
