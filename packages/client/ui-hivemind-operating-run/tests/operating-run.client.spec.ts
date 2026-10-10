import { describe, expect, it } from 'vitest'
import {
  ConversationNodeAssembler, type ConversationNodeDefinition, type ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { operatingRunDefinitions } from '../src/client/index.ts'

interface Snapshot { readonly nodes: ReadonlyMap<string, ChatConversationViewNode> }

class Definitions {
  entries(): readonly ConversationNodeDefinition[] { return operatingRunDefinitions }
  fallbackEntry(): undefined { return undefined }
}

const view: ConversationViewDefinition<ChatConversationViewNode, Snapshot> = {
  target: 'chat',
  create: () => {
    let nodes = new Map<string, ChatConversationViewNode>()
    const snapshot = (): Snapshot => ({ nodes })
    return {
      empty: snapshot(),
      replace: ({ nodes: next }) => { nodes = new Map(next.map(node => [node.key, node])); return snapshot() },
      apply: ({ upserts }) => { nodes = new Map(nodes); for (const node of upserts) nodes.set(node.key, node); return snapshot() },
    }
  },
}

class Views {
  entries(): readonly ConversationViewDefinition[] { return [view] }
}

function event(seq: number, type: string, data: unknown): SessionEventLikeEntry {
  return { type: 'event', event: { seq, time: seq, type, data } as SessionEvent }
}

function assemble(events: readonly SessionEventLikeEntry[]): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new Definitions(), new Views())
  value.replaceWindow(events, false)
  value.activateTarget('chat')
  return value
}

function nodes(value: ConversationNodeAssembler): readonly ChatConversationViewNode[] {
  return [...((value.snapshot('chat') as Snapshot).nodes.values())]
}

describe('HIVE-MIND operating-run projection', () => {
  it('folds repeated receipt identities without breaking history or duplicating cards', () => {
    const value = assemble([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'hivemind/operating-receipt', { receiptId: 'artifact:call-1', toolName: 'image_generate', status: 'running' }),
      event(3, 'hivemind/operating-receipt', { receiptId: 'artifact:call-1', toolName: 'image_generate', status: 'completed' }),
    ])
    expect(nodes(value)).toHaveLength(1)
    expect(nodes(value)[0]).toMatchObject({ anchorSeq: 2, visibility: 'visible', data: { status: 'completed' } })
  })

  it('projects loaded methods before the durable plan, research receipt, and employee handoff', () => {
    const value = assemble([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'hivemind/playbooks-loaded', { runId: 'run-1', playbooks: [{ id: 'global-research', version: '1.0.0' }, { id: 'investor-evidence-deck', version: '1.0.0' }] }),
      event(3, 'hivemind/run-plan', { runId: 'run-1', objective: 'Build a sourced investor deck', approach: 'Research then render', playbooks: [{ id: 'investor-evidence-deck', reason: 'Investor task' }] }),
      event(4, 'hivemind/research-requested', { runId: 'run-1', jobId: 'job-1', type: 'multi_hop', route: '/api/web/research/jobs', status: 'queued', objective: 'Verify market claims' }),
      event(5, 'hivemind/research-receipt', { runId: 'run-1', jobId: 'job-1', status: 'completed', provider: 'fetch', resultCount: 1, sources: [{ url: 'https://example.com' }], evidenceState: 'ready' }),
      event(6, 'hivemind/employee-delegation-start', { delegationId: 'employee-1', employeeId: 'a', employeeName: 'Marta', role: 'Risk reviewer', task: 'Challenge claims', acceptanceCriteria: ['Return cited risks'], selectedPlaybooks: [{ id: 'global-research', version: '1.0.0' }], reason: 'Independent review', modelRoute: {}, effectiveToolPolicy: { deny: [] } }),
      event(7, 'hivemind/employee-delegation-end', { delegationId: 'employee-1', employeeId: 'a', childSessionId: 'child', status: 'completed', outputPreview: 'Three cited risks.' }),
    ])
    expect(nodes(value).map(node => node.kind)).toEqual([
      'hivemind-operating-methods', 'hivemind-operating-plan', 'hivemind-operating-research', 'hivemind-operating-employee',
    ])
    expect(nodes(value)[0]?.data).toMatchObject({ methods: ['global-research', 'investor-evidence-deck'] })
    expect(nodes(value)[2]?.data).toMatchObject({ evidenceState: 'ready', sourceCount: 1, provider: 'fetch' })
    expect(nodes(value)[3]?.data).toMatchObject({ employeeName: 'Marta', status: 'completed', childSessionId: 'child', acceptanceCriteria: ['Return cited risks'], playbooks: ['global-research'], outputPreview: 'Three cited risks.' })
  })

  it('projects compact retrieval coverage without exposing raw company evidence in chat', () => {
    const value = assemble([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'hivemind/operating-context', {
        runId: 'run-context',
        internalEvidence: { count: 2, results: [{ title: 'Private evidence', content: 'Do not render this body' }] },
        playbookCandidates: [{ id: 'global-research' }, { id: 'eu-sovereign-ai-demand' }],
        employeeCandidates: [{ id: 'marta' }],
        retrieval: { additionalRecallNeeded: false, externalEvidenceLikelyNeeded: true },
      }),
    ])
    expect(nodes(value)).toHaveLength(1)
    expect(nodes(value)[0]).toMatchObject({ kind: 'hivemind-operating-context', data: {
      evidenceCount: 2, employeeCount: 1, playbookCount: 2,
      additionalRecallNeeded: false, externalEvidenceLikelyNeeded: true,
    } })
    expect(JSON.stringify(nodes(value)[0]?.data)).not.toContain('Private evidence')
    expect(operatingRunDefinitions.some(definition => definition.kind === 'assistant-presentation')).toBe(true)
    const presentation = operatingRunDefinitions.find(definition => definition.kind === 'assistant-presentation')
    expect(presentation?.start?.({} as never, { location: { kind: 'turn', turn: { turn: 1 } } } as never, { previous: () => undefined })).toMatchObject({ reasoning: 'trajectory-only', ownsTurn: true })
  })

  it('does not collide on turn presentation when operating context is retrieved twice', () => {
    expect(() => assemble([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'hivemind/operating-context', { runId: 'first' }),
      event(3, 'hivemind/operating-context', { runId: 'second' }),
      event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])).not.toThrow()
  })

  it('projects a failed employee handoff without claiming a completed action', () => {
    const value = assemble([
      event(1, 'hivemind/employee-delegation-start', { delegationId: 'employee-2', employeeId: 'b', employeeName: 'Nora', role: 'Researcher', task: 'Find sources', reason: 'Coverage', modelRoute: {}, effectiveToolPolicy: { deny: [] } }),
      event(2, 'hivemind/employee-delegation-end', { delegationId: 'employee-2', employeeId: 'b', status: 'failed', diagnostic: 'Provider unavailable' }),
    ])
    expect(nodes(value)[0]?.data).toMatchObject({ status: 'failed', diagnostic: 'Provider unavailable' })
  })

  it('does not add an operating surface to ordinary native Harness events', () => {
    const value = assemble([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'user/message', { turn: 1, text: 'Hello' }),
      event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(nodes(value)).toEqual([])
  })

  it('projects a durable rendered PDF as a visible chat artifact', () => {
    const value = assemble([
      event(1, 'hivemind/artifact-created', {
        artifactId: 'artifact-1', title: 'German Banking Recommendation', mediaType: 'application/pdf',
        provider: 'playwright', path: '/workspace/.hivemind/artifacts/banking.pdf', pageSize: 'A4', pageCount: 1, pdfBytes: 2400,
        pdf: { attachmentId: `sha256:${'aa'.repeat(32)}`, name: 'banking.pdf', bytes: 2400 },
        preview: { attachmentId: `sha256:${'bb'.repeat(32)}`, mediaType: 'image/png', name: 'banking-preview.png', bytes: 1200, width: 1240, height: 1754 },
      }),
    ])
    expect(nodes(value)).toHaveLength(1)
    expect(nodes(value)[0]).toMatchObject({
      kind: 'hivemind-artifact', visibility: 'visible', processDisclosure: 'independent',
      data: { title: 'German Banking Recommendation', provider: 'playwright', pageSize: 'A4', pageCount: 1, pdfBytes: 2400, path: '/workspace/.hivemind/artifacts/banking.pdf' },
    })
  })

  it('preserves image MIME and preview on a generated artifact receipt', () => {
    const value = assemble([event(1, 'hivemind/generation-created', {
      artifactId: 'image-1', title: 'Draft campaign', format: 'image', mediaType: 'image/webp',
      path: '/workspace/draft.webp', provider: 'test-image', file: { bytes: 50 },
      preview: { attachmentId: `sha256:${'cc'.repeat(32)}`, mediaType: 'image/webp', bytes: 50, width: 8, height: 8 },
    })])
    expect(nodes(value)[0]).toMatchObject({ kind: 'hivemind-artifact', processDisclosure: 'independent', data: {
      mediaType: 'image/webp', preview: { mediaType: 'image/webp', width: 8 },
    } })
  })

  it('projects a media job from running through terminal state beside its artifact', () => {
    const value = assemble([
      event(1, 'hivemind/media-workflow-started', { workflowId: 'media-run', jobId: 'media-1', kind: 'image', title: 'Campaign visual', provider: 'image-provider' }),
      event(2, 'hivemind/generation-created', { artifactId: 'image-1', title: 'Campaign visual', format: 'image', mediaType: 'image/png', path: '/workspace/image.png', provider: 'image-provider', file: { bytes: 20 } }),
      event(3, 'hivemind/media-workflow-ended', { workflowId: 'media-run', jobId: 'media-1', kind: 'image', title: 'Campaign visual', provider: 'image-provider', status: 'completed', attempts: 2 }),
    ])
    expect(nodes(value).map(node => node.kind)).toEqual(['hivemind-media-workflow', 'hivemind-artifact'])
    expect(nodes(value)[0]?.data).toMatchObject({ title: 'Campaign visual', status: 'completed', attempts: 2 })
  })

  it('folds repeated media start receipts when older history is prepended', () => {
    const value = assemble([
      event(2, 'hivemind/media-workflow-started', { workflowId: 'retried-media', kind: 'image' }),
      event(3, 'hivemind/media-workflow-ended', { workflowId: 'retried-media', status: 'completed' }),
    ])
    value.prepend([event(1, 'hivemind/media-workflow-started', { workflowId: 'retried-media', kind: 'image' })], false)
    expect(nodes(value)).toHaveLength(1)
    expect(nodes(value)[0]?.data).toMatchObject({ status: 'completed' })
  })

  it('replays plan revision and inline workstream progress as visible operating state', () => {
    const value = assemble([
      event(1, 'hivemind/run-plan', { planId: 'p1', revision: 1, objective: 'Assess market', approach: 'Analyze', playbooks: [], workstreams: [{ id: 'review', objective: 'Review evidence', actor: { kind: 'inline_employee', employeeId: 'marta' } }] }),
      event(2, 'hivemind/run-plan-revised', { planId: 'p1', revision: 2, revisionReason: 'Add review', objective: 'Assess market', approach: 'Analyze then review', playbooks: [], workstreams: [{ id: 'review', objective: 'Review evidence', actor: { kind: 'inline_employee', employeeId: 'marta' } }] }),
      event(3, 'hivemind/workstream-started', { planId: 'p1', planRevision: 2, workstreamId: 'review', objective: 'Review evidence', approvalRequired: true, actor: { kind: 'inline_employee', employeeId: 'marta', employeeName: 'Marta', role: 'skeptic', avatarUrl: 'https://example.com/marta.png' } }),
      event(4, 'hivemind/workstream-approval', { planId: 'p1', workstreamId: 'review', outcome: 'allowed-once', reason: 'Approve recommendation.' }),
      event(5, 'hivemind/workstream-completed', { planId: 'p1', workstreamId: 'review', summary: 'Evidence reviewed.', evidenceIds: ['e1'], artifactIds: [] }),
    ])
    expect(nodes(value).map(node => node.kind)).toEqual(['hivemind-operating-plan', 'hivemind-operating-workstream'])
    expect(nodes(value)[0]?.data).toMatchObject({ revision: 2, approach: 'Analyze then review' })
    expect(nodes(value)[0]?.data).toMatchObject({ workstreams: [{
      id: 'review', objective: 'Review evidence', status: 'completed', actorKind: 'inline_employee',
      employeeId: 'marta', actorName: 'Marta', role: 'skeptic', avatarUrl: 'https://example.com/marta.png',
      summary: 'Evidence reviewed.',
    }] })
    expect(nodes(value)[1]?.data).toMatchObject({ status: 'completed', approvalRequired: true, approvalStatus: 'approved', employeeId: 'marta', actorName: 'Marta', role: 'skeptic', avatarUrl: 'https://example.com/marta.png', summary: 'Evidence reviewed.' })
  })

  it('keeps a pending durable research receipt visibly waiting instead of treating it as completed', () => {
    const value = assemble([
      event(1, 'hivemind/research-requested', { jobId: 'pending-1', type: 'multi_hop', status: 'queued', objective: 'Collect sources' }),
      event(2, 'hivemind/research-receipt', { jobId: 'pending-1', status: 'running', sources: [], evidenceState: 'pending' }),
    ])
    expect(nodes(value)[0]?.data).toMatchObject({ evidenceState: 'waiting', sourceCount: 0 })
  })

  it('keeps a queued native employee child visibly waiting until its terminal receipt arrives', () => {
    const value = assemble([
      event(1, 'hivemind/employee-delegation-start', { delegationId: 'employee-pending', jobId: 'hivemind_employee-1', executionState: 'pending', employeeId: 'marta', employeeName: 'Marta', role: 'Risk lead', task: 'Challenge the recommendation', acceptanceCriteria: [], selectedPlaybooks: [] }),
    ])
    expect(nodes(value)[0]?.data).toMatchObject({ employeeName: 'Marta', status: 'waiting' })
  })

  it('hides historical internal skill receipts while retaining genuine deliverable receipts', () => {
    const value = assemble([
      event(1, 'hivemind/operating-receipt', { runId: 'run-1', planId: 'plan-1', receiptId: 'artifact:skill-1', kind: 'artifact', status: 'completed', title: 'Artifact receipt', toolName: 'skill' }),
      event(2, 'hivemind/operating-receipt', { runId: 'run-1', planId: 'plan-1', receiptId: 'artifact:image-1', kind: 'artifact', status: 'completed', title: 'Artifact receipt', toolName: 'image_generate' }),
    ])
    expect(nodes(value)[0]?.visibility).toBe('hidden')
    expect(nodes(value)[1]?.visibility).toBe('visible')
  })

  it('projects native receipts and a compact evaluation without replacing their native tool cards', () => {
    const value = assemble([
      event(1, 'hivemind/run-plan', { runId: 'run-1', planId: 'plan-1', objective: 'Produce a visual report', approach: 'Render and inspect', playbooks: [] }),
      event(2, 'hivemind/operating-receipt', { runId: 'run-1', planId: 'plan-1', receiptId: 'browser:c1', kind: 'browser', status: 'completed', title: 'Browser receipt', toolName: 'browser_take_screenshot' }),
      event(3, 'hivemind/operating-receipt', { runId: 'run-1', planId: 'plan-1', receiptId: 'artifact:c2', kind: 'artifact', status: 'completed', title: 'Artifact receipt', toolName: 'image_generate' }),
      event(4, 'hivemind/operating-receipt', { runId: 'run-1', planId: 'plan-1', receiptId: 'action:c3', kind: 'connected_action', status: 'completed', title: 'Approved connected action', toolName: 'send_email' }),
      event(5, 'hivemind/run-evaluation', { runId: 'run-1', planId: 'plan-1', status: 'ready', receiptCounts: { browser: 1, artifact: 1, connected_action: 1 }, next: 'Synthesize the requested outcome.' }),
    ])
    expect(nodes(value).map(node => node.kind)).toEqual([
      'hivemind-operating-plan', 'hivemind-operating-receipt', 'hivemind-operating-receipt', 'hivemind-operating-receipt', 'hivemind-operating-evaluation',
    ])
    expect(nodes(value)[2]?.data).toMatchObject({ kind: 'artifact', status: 'completed', toolName: 'image_generate' })
    expect(nodes(value)[4]?.data).toMatchObject({ receiptCounts: [{ kind: 'browser', count: 1 }, { kind: 'artifact', count: 1 }, { kind: 'connected_action', count: 1 }] })
  })
})

it('keeps reused workstream names separate when older updates arrive before their start', () => {
  const value = new ConversationNodeAssembler(new Definitions(), new Views())
  const fields = (runId: string) => ({ runId, planId: `plan-${runId}`, workstreamId: 'assessment' })
  value.replaceWindow([event(30, 'hivemind/workstream-started', {
    ...fields('new'), objective: 'Current assessment', actor: { kind: 'main' },
  })], true)
  value.activateTarget('chat')
  expect(() => value.prepend([event(20, 'hivemind/workstream-completed', {
    ...fields('old'), summary: 'Earlier assessment finished', evidenceIds: [], artifactIds: [],
  })], true)).not.toThrow()
  value.prepend([event(10, 'hivemind/workstream-started', {
    ...fields('old'), objective: 'Earlier assessment', actor: { kind: 'main' },
  })], false)
  value.flush()
  expect(nodes(value).map(node => node.data)).toEqual(expect.arrayContaining([
    expect.objectContaining({ objective: 'Earlier assessment', status: 'completed', summary: 'Earlier assessment finished' }),
    expect.objectContaining({ objective: 'Current assessment', status: 'running' }),
  ]))
  expect(nodes(value).map(node => node.anchorSeq).sort((a, b) => a - b)).toEqual([10, 30])
})

it('preserves real pre-start progress without claiming the workstream started early', () => {
  const fields = { runId: '21afc34b', planId: '7cdf99a8', workstreamId: 'assessment' }
  const progress = event(128, 'hivemind/workstream-progress', { ...fields, summary: 'Research evidence gathered.' })
  const started = event(146, 'hivemind/workstream-started', { ...fields, planRevision: 1,
    objective: 'Assess positioning', actor: { kind: 'main' } })
  const completed = event(215, 'hivemind/workstream-completed', { ...fields,
    summary: 'Assessment finished.', evidenceIds: [], artifactIds: [] })
  for (const paged of [false, true]) {
    const value = new ConversationNodeAssembler(new Definitions(), new Views())
    value.replaceWindow(paged ? [started, completed] : [progress, started, completed], paged)
    value.activateTarget('chat')
    if (paged) value.prepend([progress], false)
    value.flush()
    const rows = [...nodes(value)].sort((a, b) => a.anchorSeq - b.anchorSeq)
    expect(rows.map(row => row.anchorSeq)).toEqual([128, 146])
    expect(rows[0]?.data).toMatchObject({ title: 'Work progress', summary: 'Research evidence gathered.' })
    expect(rows[1]?.data).toMatchObject({ objective: 'Assess positioning', status: 'completed', summary: 'Assessment finished.' })
  }
})

it('preserves distinct method loads for the same run across reload and overlapping history pages', () => {
  const runId = '3a554265-af85-475d-810d-f27d9739973e'
  const first = event(128, 'hivemind/playbooks-loaded', { runId, playbooks: [{ id: 'research', version: '1' }] })
  const second = event(146, 'hivemind/playbooks-loaded', { runId, playbooks: [{ id: 'review', version: '2' }] })
  const full = assemble([first, second])
  const paged = assemble([second])
  expect(() => paged.prepend([first, second], false)).not.toThrow()
  expect(() => paged.prepend([first], false)).not.toThrow()
  paged.flush()
  const receipt = (value: ConversationNodeAssembler) => [...nodes(value)].sort((a, b) => a.anchorSeq - b.anchorSeq).map(node => ({
    key: node.key, anchorSeq: node.anchorSeq, data: node.data,
  }))
  expect(receipt(paged)).toEqual(receipt(full))
  expect(nodes(paged)).toHaveLength(2)
  expect(nodes(paged).map(node => node.anchorSeq).sort((a, b) => a - b)).toEqual([128, 146])
})
