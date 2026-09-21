/** HIVE-MIND chat-only Web profile bundle marker. */
export const name = 'hivemind-web-app'

/** The HIVE profile owns this public browser-presentation value. */
export const inject = ['webServer']

/**
 * Publish HIVE-only presentation policy at the HTML boundary. The durable
 * system/request events remain available for replay and inspection; only their
 * chat transcript disclosure cards are suppressed in the HIVE browser shell.
 */
export function apply(ctx: {
  on(event: 'webserver/index-inject', listener: (table: Array<{ kind: 'global'; name: string; value: unknown }>) => void): unknown
}): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_HIVEMIND_CHAT_PRESENTATION__',
      value: { showSystemPrompts: false },
    })
  })
}
