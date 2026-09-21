import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Caller-owned descriptive facts; these never grant organization permissions. */
export const PROFILE_FIELDS = ['name', 'role', 'company', 'language', 'location', 'timezone'] as const
/** Explicit values approved by the authenticated caller. */
export interface ProfileUpdateRequest { fields: Partial<Record<typeof PROFILE_FIELDS[number], string>> }
type Receipt = Record<string, JsonValue>
type Update = (agent: Agent, request: ProfileUpdateRequest, signal: AbortSignal) => Promise<Receipt>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'hivemind/profile-update': {
      operation_id: string
      status: 'prepared' | 'approved' | 'completed' | 'cancelled' | 'failed'
      result?: Receipt
    }
  }
}

/** Register a caller-scoped, approval-gated profile setter owned by Cordis. */
export function registerProfileUpdate(ctx: Context, update: Update): () => void {
  return ctx.tools.register(defineTool({
    name: 'hivemind_update_profile',
    description: "Update the authenticated user's own maintained profile after approval. Use for change my name, role, company, language, location or timezone. Not a memory preference substitute; cannot change other people, login credentials, organization ownership or access roles.",
    parameters: { fields: { type: 'object', required: true, additionalProperties: false,
      properties: Object.fromEntries(PROFILE_FIELDS.map(field => [field, { type: 'string', description: 'Explicit new value, 1–500 characters.' }])) } },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution: ToolExecution) {
      const agent = execution.agent
      if (agent === undefined) throw new Error('Profile update requires an authenticated session')
      const raw: unknown = args['fields']
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Profile fields must be an object')
      const fields: ProfileUpdateRequest['fields'] = {}
      for (const [key, value] of Object.entries(raw)) {
        if (!PROFILE_FIELDS.includes(key as typeof PROFILE_FIELDS[number]) || typeof value !== 'string' || !value.trim() || value.length > 500) throw new TypeError('Unsupported profile field or value')
        fields[key as typeof PROFILE_FIELDS[number]] = value.trim()
      }
      if (!Object.keys(fields).length) throw new TypeError('At least one changed profile field is required')
      const operationId = `profile:${execution.callId}`
      const append = (status: 'prepared' | 'approved' | 'completed' | 'cancelled' | 'failed', result?: Receipt) => {
        agent.session.append('hivemind/profile-update', { operation_id: operationId, status, ...(result ? { result } : {}) }, { ignorable: true })
      }
      const prior = agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/profile-update' && event.data.operation_id === operationId)
      if (prior?.type === 'hivemind/profile-update' && prior.data.status === 'completed' && prior.data.result) return prior.data.result
      if (prior?.type === 'hivemind/profile-update' && prior.data.status === 'cancelled') return { status: 'cancelled', operation: 'update_profile' }
      try {
        if (!(prior?.type === 'hivemind/profile-update' && prior.data.status === 'approved')) {
          const questions = ctx.get('userQuestions') as { ask(input: { agent: Agent; signal: AbortSignal; questions: { id: string; question: string; detail: string; options: { label: string; description: string }[] }[] }): Promise<{ answers: { id: string; selected: string[] }[] }> } | undefined
          if (!questions) throw new Error('Profile approval channel unavailable')
          append('prepared')
          const reply = await questions.ask({ agent, signal: execution.signal, questions: [{
            id: operationId, question: 'Update your profile?',
            detail: Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n'),
            options: [{ label: 'Approve', description: 'Apply exactly these changes to your own profile.' }, { label: 'Cancel', description: 'Keep your profile unchanged.' }],
          }] })
          if (!reply.answers.some(answer => answer.id === operationId && answer.selected.includes('Approve'))) {
            append('cancelled')
            return { status: 'cancelled', operation: 'update_profile' }
          }
          append('approved')
        }
        const result = await update(agent, { fields }, execution.signal)
        append('completed', result)
        return result
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
        if (execution.signal.aborted || code === 'ASK_ABORTED' || code === 'ASK_CANCELLED') {
          append('cancelled')
          return { status: 'cancelled', operation: 'update_profile' }
        }
        append('failed')
        throw error
      }
    },
  }))
}
