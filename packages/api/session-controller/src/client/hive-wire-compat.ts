/** Browser-only projection of the frozen HIVE runner's v2 journal. */
export function adaptHiveWireEvent(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const event = { ...value } as Record<string, unknown>
  const operation = event['surfaceOp']
  if (typeof operation === 'object' && operation !== null && !Array.isArray(operation)) {
    const old = operation as Record<string, unknown>
    if (old['op'] === 'replace' && 'start' in old && 'end' in old) {
      const { start, end, ...rest } = old
      event['surfaceOp'] = { ...rest, startSeq: start, endSeq: end }
    }
  }
  if (event['type'] === 'request/header') {
    const data = event['data']
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const header = (data as Record<string, unknown>)['header']
      if (typeof header === 'object' && header !== null && !Array.isArray(header)) {
        const { system, ...current } = header as Record<string, unknown>
        if (system !== undefined && typeof system !== 'string') throw new Error('HIVE legacy system prompt must be text')
        if (system !== undefined) current['hiveLegacySystem'] = system
        if (Array.isArray(current['tools']) && current['tools'].length === 0) delete current['tools']
        if (typeof current['adapterDefaults'] === 'object' && current['adapterDefaults'] !== null
          && Object.keys(current['adapterDefaults']).length === 0) delete current['adapterDefaults']
        event['data'] = { ...data, header: current }
      }
    }
  }
  return event
}
