/** Quiet activity presentation derived only from native logged tool execution. */
import { useSyncExternalStore } from 'react'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HivemindConnectKey } from './locales.ts'

export type ActivityKey = Extract<HivemindConnectKey, `activity.${string}`>
const labels: Record<string, ActivityKey> = {
  parallel_search: 'activity.search', hivemind_research_answer: 'activity.search',
  browser_markdown: 'activity.website', browser_extract: 'activity.website', browser_links: 'activity.website', browser_scrape: 'activity.website',
  browser_capture: 'activity.capture', hyperagents_memory: 'activity.memory', hivemind_recall: 'activity.memory',
  hivemind_generate: 'activity.draft', hivemind_artifact_render: 'activity.draft',
  wait_agent: 'activity.team', send_message: 'activity.team', hivemind_agent_message: 'activity.team',
}
/** Return the last still-running recognized tool in this turn; ended turns have no activity. */
export function currentActivity(window: SessionEventWindow, turn: number): ActivityKey | undefined {
  let activeTurn: number | undefined
  const pending = new Map<string, ActivityKey>()
  for (const entry of window.entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'turn/start') { activeTurn = event.data.turn; pending.clear() }
    if (activeTurn !== turn) continue
    if (event.type === 'turn/end') { pending.clear(); activeTurn = undefined }
    else if (event.type === 'tool/call') {
      const label = labels[event.data.name]
      if (label !== undefined) pending.set(String(event.data.callId), label)
    } else if (event.type === 'tool/result') pending.delete(String(event.data.message.source.callId))
  }
  return [...pending.values()].at(-1)
}
export function RuntimeActivity({ events, turn, t }: {
  events: { subscribe(listener: () => void): () => void; getSnapshot(): SessionEventWindow }
  turn: number
  t: (key: HivemindConnectKey) => string
}) {
  const window = useSyncExternalStore(listener => events.subscribe(listener), () => events.getSnapshot())
  const activity = currentActivity(window, turn)
  return activity === undefined ? null : <p role="status" aria-live="polite" data-runtime-activity
    style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 13, margin: '8px 0' }}>{t(activity)}</p>
}
