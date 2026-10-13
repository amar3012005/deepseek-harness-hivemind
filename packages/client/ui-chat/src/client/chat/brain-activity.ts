import type { RunningToolCall } from '../contract/snapshot.ts'
import { isRunningTool } from '../contract/chat-nodes.ts'

export interface BrainActivity { readonly label: string; readonly app?: 'gmail' }

/** Consumer labels derive only from actual in-flight tool names and action enums. */
export function brainActivity(calls: readonly RunningToolCall[]): BrainActivity | undefined {
  let latest: { time: number; activity: BrainActivity } | undefined
  const visit = (call: RunningToolCall): void => {
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(call.argsRaw) as Record<string, unknown> } catch { /* A partial argument has no claimed action. */ }
    let value: BrainActivity | undefined
    if (call.name === 'hivemind_meta') {
      value = { label: args.operation === 'context' ? 'Reading company context'
        : args.operation === 'entities' ? 'Checking saved entities'
          : ['save', 'remember', 'write'].includes(String(args.operation)) ? 'Preparing a company memory save'
            : 'Searching company brain' }
    } else if (call.name === 'hivemind_connected_task') {
      const queries = Array.isArray(args.queries) ? args.queries as Array<{ app?: unknown }> : []
      const gmail = typeof args.tool_slug === 'string' && args.tool_slug.startsWith('GMAIL_')
        || queries.some(query => typeof query.app === 'string' && query.app.toLowerCase() === 'gmail')
      const app = gmail ? 'Gmail' : 'Connected apps'
      const action = args.action === 'search' ? 'finding tools'
        : args.action === 'schemas' ? 'preparing the selected tool'
          : ['manage_connection', 'wait_connection'].includes(String(args.action)) ? 'checking connection'
            : args.action === 'execute' ? typeof args.tool_slug === 'string' && /_(?:FETCH|LIST|GET|SEARCH|READ)_/u.test(args.tool_slug)
              ? 'reading' : 'running the selected action' : 'checking access'
      value = { label: `${app}: ${action}`, ...(gmail ? { app: 'gmail' as const } : {}) }
    } else if (call.name.startsWith('GMAIL_')) {
      value = { label: /_(?:FETCH|LIST|GET|SEARCH|READ)_/u.test(call.name) ? 'Gmail: reading' : 'Gmail: writing', app: 'gmail' }
    } else if (['parallel_search', 'hivemind_research_answer'].includes(call.name)) value = { label: 'Searching web sources' }
    else if (call.name === 'hivemind_browser_capture') value = { label: 'Capturing website screenshot' }
    else if (/^browser_(?:markdown|extract|scrape|links)$/u.test(call.name)) value = { label: 'Reading website' }
    else if (call.name === 'hivemind_artifact_render') value = { label: 'Rendering report' }
    else if (['hivemind_generate', 'hivemind_media_generate'].includes(call.name)) value = { label: 'Preparing artifact' }
    if (value !== undefined && (latest === undefined || call.time >= latest.time)) latest = { time: call.time, activity: value }
    for (const child of call.subCalls) if (isRunningTool(child)) visit(child)
  }
  for (const call of calls) visit(call)
  return latest?.activity
}
