import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** HIVE-MIND chat-only Web profile bundle marker. */
export const name = 'hivemind-web-app'

/** The HIVE profile owns this public browser-presentation value. */
export const inject = ['webServer']

/**
 * Publish HIVE-only presentation policy at the HTML boundary. The durable
 * system/request events remain available for replay and inspection; only their
 * chat transcript disclosure cards are suppressed in the HIVE browser shell.
 */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push({
      kind: 'global',
      name: '__DSH_HIVEMIND_CHAT_PRESENTATION__',
      value: { showSystemPrompts: false },
    })
  })
}
