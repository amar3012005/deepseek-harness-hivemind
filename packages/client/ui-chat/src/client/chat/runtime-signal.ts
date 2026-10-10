/** Safe presentation of a connected-app update; admission is not consumption. */
export interface RuntimeSignal {
  readonly eventId: string
  readonly summary: string
  readonly action: 'notify' | 'wake'
}

export function runtimeSignal(source: unknown): RuntimeSignal | null {
  if (typeof source !== 'object' || source === null) return null
  const value = source as Record<string, unknown>
  if (value.kind !== 'hivemind-runtime-event' || typeof value.eventId !== 'string' || !value.eventId) return null
  return {
    eventId: value.eventId,
    summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary : 'Connected app update',
    action: value.action === 'notify' ? 'notify' : 'wake',
  }
}

/** Hide an admission echo once its durable consumed message is visible. */
export function pendingRuntimeSignals(
  queue: readonly { readonly source?: unknown }[],
  consumed: ReadonlySet<string>,
): readonly RuntimeSignal[] {
  const seen = new Set(consumed)
  return queue.flatMap((item) => {
    const signal = runtimeSignal(item.source)
    if (signal === null || seen.has(signal.eventId)) return []
    seen.add(signal.eventId)
    return [signal]
  })
}
