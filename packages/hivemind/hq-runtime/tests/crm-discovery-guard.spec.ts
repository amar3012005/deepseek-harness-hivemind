import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
vi.mock('../src/rest.ts', () => ({ isHqLead: (_ctx: unknown, agent: { id: string }) => agent.id === 'runtime' }))
import { crmReferenceDenial, installCrmDiscoveryGuard, requestsInternalAppReference } from '../src/crm-discovery-guard.ts'

const ctx = {} as Context
function execution(questions: unknown[], agentId = 'runtime', name = 'ask_user_question'): Readonly<ToolExecution> {
  return { name, agent: { id: agentId }, arguments: { questions } } as unknown as ToolExecution
}
describe('Runtime application discovery boundary', () => {
  it('rejects the actual production internal-reference request before entering a human wait', () => {
    expect(crmReferenceDenial(ctx, execution([{ id: 'crm-reference', question: 'Please send the saved CRM app link or application ID so I can inspect its current definition and revision before considering your audit-firm changes.' }]))).toContain('hivemind_app_list')
  })
  it('returns exact discovery and current-read instructions without granting edits', () => {
    const reason = crmReferenceDenial(ctx, execution([{ question: 'Can you provide the CRM UUID?' }]))!
    expect(reason).toContain('hivemind_capabilities')
    expect(reason).toContain('hivemind_app_get')
    expect(reason).toContain('does not authorize edits')
  })
  it('preserves independent business questions in a mixed rejected batch without inventing answers', () => {
    const questions = [{ question: 'Please share the application ID for the CRM.' }, { question: 'What is the paid-trial length and VAT treatment?' }]
    const before = structuredClone(questions)
    expect(crmReferenceDenial(ctx, execution(questions))).toContain('ask those separately')
    expect(questions).toEqual(before)
  })
  it.each(['Which named workspace should I expand: Audit CRM or Sales CRM?', 'What is the paid-trial length and cancellation policy?', 'Can you connect Google Sheets?', 'Which application should we build next?'])('retains genuine question: %s', (question) => {
    expect(crmReferenceDenial(ctx, execution([{ question }]))).toBeUndefined()
  })
  it('does not alter direct employee questions or other tool calls', () => {
    const questions = [{ question: 'Please provide the CRM application ID.' }]
    expect(crmReferenceDenial(ctx, execution(questions, 'employee'))).toBeUndefined()
    expect(crmReferenceDenial(ctx, execution(questions, 'runtime', 'hivemind_app_get'))).toBeUndefined()
  })
  it('does not coerce malformed fields or match evidence-only descriptions', () => {
    expect(requestsInternalAppReference({ question: {}, detail: 'Please send the CRM app ID.' })).toBe(false)
    expect(requestsInternalAppReference({ question: 'Which business scope?', detail: 'Saved app ID is unavailable' })).toBe(false)
  })
  it('installs the reversible native monotonic guard', () => {
    const dispose = vi.fn(), guard = vi.fn((_executionGuard: (execution: Readonly<ToolExecution>) => string | undefined) => dispose)
    const fixture = { effect: (callback: () => unknown) => callback(), tools: { guard } } as unknown as Context
    installCrmDiscoveryGuard(fixture)
    expect(guard).toHaveBeenCalledOnce()
    expect(guard.mock.calls[0]![0](execution([{ question: 'Please give the CRM application ID.' }]))).toContain('runtime_app_reference_discovery_required')
  })
})
