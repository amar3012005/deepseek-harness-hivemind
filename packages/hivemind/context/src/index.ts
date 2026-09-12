/** HIVE-MIND organization and recent-conversation context projection. */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
/** Authenticated profile evidence loaded lazily by the HIVE runtime. */
export interface ProfileSnapshot { identity: { userId: string; orgId: string }; initialContext: string; fullContext: string }
/** Prompt-projection budgets and the registered on-demand capability tool. */
export interface ContextConfig { historyTurns: number; historyMaxChars: number; capabilityToolName: string }
interface ConversationExchange { turn: number; user: string; assistant: string }
const PROFILE_CONTEXT_SOURCE = 'dsh-hivemind-runtime/profile'
const HISTORY_CONTEXT_SOURCE = 'dsh-hivemind-runtime/history'
function textOf(message: Message): string { return message.content.filter((block): block is Extract<ContentBlock,{ type:'text' }> => block.type === 'text').map(block => block.text.trim()).filter(Boolean).join('\n') }
/**
 * Extract completed direct-user/final-assistant exchanges from durable events.
 * @param events - append-only session events.
 * @returns completed exchanges in turn order.
 */
export function completedExchanges(events: readonly SessionEvent[]): ConversationExchange[] { const users = new Map<number,string[]>(), assistants = new Map<number,string>(), completed = new Set<number>(); let open: number|undefined; for (const event of events) { if (event.type === 'turn/start') { open = event.data.turn; continue } if (event.type === 'turn/end') { completed.add(event.data.turn); if (open === event.data.turn) open = undefined; continue } if (!isAppendSurfaceEvent(event)) continue; if (event.type === 'user/message' && open !== undefined && event.data.source.kind === 'user') { const value = textOf(event.data); if (value) users.set(open,[...users.get(open)??[],value]) } else if (event.type === 'assistant/message') { const value = textOf(event.data.message); if (value) assistants.set(event.data.turn,value) } } return [...completed].sort((a,b)=>a-b).flatMap((turn)=>{ const user=users.get(turn)?.join('\n'),assistant=assistants.get(turn); return user===undefined||assistant===undefined?[]:[{ turn,user,assistant }] }) }
/**
 * Render a bounded recent-conversation projection without old tool payloads.
 * @param exchanges - completed exchanges in turn order.
 * @param maxTurns - maximum number of newest exchanges to retain.
 * @param maxChars - maximum projection character count.
 * @returns model-facing recent conversation text.
 */
export function recentConversationText(exchanges: readonly ConversationExchange[], maxTurns: number, maxChars: number): string { const heading='## Recent conversation\nOnly completed user requests and final answers are retained; tool calls and tool outputs are omitted. The separate user message after this block is the current request and must be answered.\n'; const selected:string[]=[]; let remaining=maxChars-heading.length; for(const exchange of exchanges.slice(-maxTurns).reverse()){const rendered=`\n### User\n${exchange.user}\n\n### Assistant\n${exchange.assistant}\n`;if(rendered.length<=remaining){selected.unshift(rendered);remaining-=rendered.length;continue}if(selected.length>0||remaining<80)break;const userBudget=Math.max(20,Math.floor(remaining*.35)),assistantBudget=Math.max(20,remaining-userBudget-36);selected.unshift(`\n### User\n${exchange.user.slice(0,userBudget)}\n\n### Assistant\n${exchange.assistant.slice(0,assistantBudget)}\n`);break}return `${heading}${selected.join('')}`.slice(0,maxChars) }
const IDENTITY_CONTEXT_SOURCE = 'dsh-hivemind-runtime/identity-context'
function projectHistory(agent: Agent, config: ContextConfig): boolean {
  const session = agent.session
  const events = session.snapshotEvents()
  const exchanges = completedExchanges(events)
  if (exchanges.length === 0) return false
  const lastCompleted = events.findLast(event => event.type === 'turn/end')
  if (lastCompleted === undefined || lastCompleted.data.reason.kind !== 'completed') return false
  const nodes = [...session.surface.nodes].filter(seq => seq < lastCompleted.seq)
  // Keep current system/profile context outside the replacement interval.
  // A connected-app conversation need not contain any profile injection.
  const pinned = nodes.findLastIndex((seq) => {
    const event = session.eventAt(seq)
    return event?.type === 'system/message' || (event?.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && [PROFILE_CONTEXT_SOURCE, IDENTITY_CONTEXT_SOURCE].includes(event.data.source.plugin))
  })
  const shadowed = nodes.slice(pinned + 1)
  const start = shadowed[0], end = shadowed.at(-1)
  if (start === undefined || end === undefined) return false
  const text = recentConversationText(exchanges, config.historyTurns, config.historyMaxChars)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: HISTORY_CONTEXT_SOURCE, form: 'recall' },
  }), { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: shadowed })
  return true
}
function capabilityCatalogRequested(events: readonly SessionEvent[], turn: number, toolName: string): boolean {
  return events.some(event => event.type === 'tool/call'
    && event.data.turn === turn
    && event.data.name === toolName)
}
function isSkillCatalog(message: Message): boolean {
  return (message.source as { readonly kind: string }).kind === 'skill-catalog'
}

/**
 * Project compact history and reveal the native skill catalog only after model request.
 * @param config - history budgets and the registered capability-request tool name.
 * @returns A Cordis plugin that projects model context without changing the native agent loop.
 */
export function contextPlugin(config: ContextConfig): Plugin.Object<void> {
  return {
    name: 'hivemind-context',
    apply(ctx: Context): void {
      const projected = new WeakMap<Agent, number>()
      ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
        const decision = await next()
        if (decision.kind === 'reject') return decision

        const first = projected.get(agent) !== turn
        if (first) projected.set(agent, turn)
        const changed = first && projectHistory(agent, config)
        const showCatalog = capabilityCatalogRequested(
          agent.session.snapshotEvents(),
          turn,
          config.capabilityToolName,
        )
        const messages = showCatalog
          ? decision.messages
          : decision.messages.filter(message => !isSkillCatalog(message))
        return changed
          ? { ...decision, messages, startsRequestSeries: true }
          : { ...decision, messages }
      }, { prepend: true })
    },
  }
}
