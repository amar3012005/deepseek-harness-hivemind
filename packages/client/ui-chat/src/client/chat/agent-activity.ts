import type { RunningToolCall } from '../contract/snapshot.ts'
import { isRunningTool } from '../contract/chat-nodes.ts'

const activity = {
  parallel_search: 'chat.activity.search',
  hivemind_research_answer: 'chat.activity.search',
  browser_markdown: 'chat.activity.website',
  browser_extract: 'chat.activity.website',
  browser_links: 'chat.activity.website',
  browser_scrape: 'chat.activity.website',
  hivemind_artifact_inspect: 'chat.activity.review',
  read_file: 'chat.activity.read',
  hyperagents_memory: 'chat.activity.memory',
  hivemind_recall: 'chat.activity.memory',
  hivemind_generate: 'chat.activity.create',
  hivemind_artifact_render: 'chat.activity.create',
  hivemind_agent_message: 'chat.activity.team',
  send_message: 'chat.activity.team',
  spawn_teammate: 'chat.activity.team',
  team_task_create: 'chat.activity.team',
  team_task_update: 'chat.activity.team',
  wait_agent: 'chat.activity.wait',
} as const

export type AgentActivityKey = typeof activity[keyof typeof activity]

/** Read only the names of actual in-flight calls, never their arguments. */
export function agentActivity(calls: readonly RunningToolCall[]): AgentActivityKey | undefined {
  let latest: { time: number; key: AgentActivityKey } | undefined
  const visit = (call: RunningToolCall): void => {
    const key = Object.hasOwn(activity, call.name) ? activity[call.name as keyof typeof activity] : undefined
    if (key !== undefined && (latest === undefined || call.time >= latest.time)) latest = { time: call.time, key }
    for (const child of call.subCalls) if (isRunningTool(child)) visit(child)
  }
  for (const call of calls) visit(call)
  return latest?.key
}
