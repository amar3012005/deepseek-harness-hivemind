/** Browser projection of durable HyperAgents operating activity. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-hivemind-employee-delegation'
import type {} from '@deepseek-ai/dsh-hivemind-playbooks'
import type {} from '@deepseek-ai/dsh-hivemind-operating-workstreams'
import type {} from '@deepseek-ai/dsh-hivemind-research'
import type {} from '@deepseek-ai/dsh-hivemind-artifact-renderer'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { Avatar } from '@humation/react'
import { humation1 } from '@humation/assets-humation-1'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ImageProgress } from './ImageProgress.tsx'
import { fileArtifactBlob, saveArtifact } from './download.ts'
import css from './OperatingRun.module.css'
import { en, NS, type OperatingRunKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** HIVE-MIND operating-run card copy. */
    hivemindOperatingRun: OperatingRunKey
  }
}

type OperatingWorkstreamStatus = 'queued' | 'running' | 'completed' | 'failed'

interface PlanWorkstreamData {
  readonly id: string
  readonly objective: string
  readonly actorKind: string
  readonly employeeId?: string
  readonly actorName?: string
  readonly role?: string
  readonly avatarUrl?: string
  readonly status: OperatingWorkstreamStatus
  readonly summary?: string
}

interface PlanData {
  readonly revision: number
  readonly objective: string
  readonly approach: string
  readonly playbooks: readonly { readonly id: string; readonly reason: string }[]
  readonly workstreams: readonly PlanWorkstreamData[]
}

interface OperatingContextData {
  readonly evidenceCount: number
  readonly employeeCount: number
  readonly playbookCount: number
  readonly additionalRecallNeeded: boolean
  readonly externalEvidenceLikelyNeeded: boolean
}

interface MethodsData {
  readonly methods: readonly string[]
}

interface WorkstreamData {
  readonly objective: string
  readonly actorKind: string
  readonly employeeId?: string
  readonly actorName?: string
  readonly role?: string
  readonly avatarUrl?: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly approvalRequired: boolean
  readonly approvalStatus?: 'approved' | 'rejected' | 'cancelled' | 'unavailable'
  readonly summary?: string
}

interface ResearchData {
  readonly objective: string
  readonly type: string
  readonly status: string
  readonly evidenceState: 'queued' | 'waiting' | 'running' | 'ready' | 'partial' | 'unavailable' | 'failed'
  readonly sourceCount: number
  readonly provider?: string
}

interface EmployeeData {
  readonly employeeId: string
  readonly employeeName: string
  readonly role: string
  readonly task: string
  readonly status: 'waiting' | 'running' | 'completed' | 'failed'
  readonly childSessionId?: string
  readonly diagnostic?: string
  readonly acceptanceCriteria: readonly string[]
  readonly playbooks: readonly string[]
  readonly outputPreview?: string
}

interface ReceiptData {
  readonly kind: string
  readonly title: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly toolName?: string
  readonly summary?: string
}

interface EvaluationData {
  readonly receiptCounts: readonly { readonly kind: string; readonly count: number }[]
  readonly next: string
}

interface ArtifactData {
  readonly title: string
  readonly path: string
  readonly provider: string
  readonly mediaType: string
  readonly pageSize: 'A4' | 'Letter'
  readonly pageCount: number
  readonly pdfBytes: number
  readonly file?: FileAttachmentRef
  readonly preview?: ImageAttachmentRef
}

interface MediaWorkflowData {
  readonly startedAt?: number
  readonly kind: string
  readonly title: string
  readonly provider: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly attempts?: number
  readonly diagnostic?: string
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Compact authoritative retrieval coverage for one company objective. */
    'hivemind-operating-context': OperatingContextData
    /** Global doctrine and local methods made available before an operating plan. */
    'hivemind-operating-methods': MethodsData
    /** Durable selected operating method for a substantial HIVE-MIND run. */
    'hivemind-operating-plan': PlanData
    /** Durable plan-selected workstream execution. */
    'hivemind-operating-workstream': WorkstreamData
    /** Durable governed research lifecycle and bounded source receipt. */
    'hivemind-operating-research': ResearchData
    /** Durable frozen employee handoff lifecycle. */
    'hivemind-operating-employee': EmployeeData
    /** Native browser, artifact, workflow, or approved-action receipt projected into an operating run. */
    'hivemind-operating-receipt': ReceiptData
    /** Observational completion proposal after all known work for a run settled. */
    'hivemind-operating-evaluation': EvaluationData
    /** Durable rendered artifact with an always-visible preview. */
    'hivemind-artifact': ArtifactData
    /** Durable image/video workflow activity, independent of its completed artifact. */
    'hivemind-media-workflow': MediaWorkflowData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** HyperAgents keeps private reasoning in Trajectory while Chat shows durable operating activity. */
    'assistant-presentation': {
      readonly reasoning: 'chat' | 'trajectory-only'
    }
  }
}

function operatingContextData(event: SessionEventLike): OperatingContextData {
  const data = record(event.data) ?? {}
  const evidence = record(data['internalEvidence']) ?? {}
  const retrieval = record(data['retrieval']) ?? {}
  const evidenceCount = typeof evidence['count'] === 'number' ? evidence['count'] : strings(evidence['results']).length
  return {
    evidenceCount,
    employeeCount: strings(data['employeeCandidates']).length,
    playbookCount: strings(data['playbookCandidates']).length,
    additionalRecallNeeded: retrieval['additionalRecallNeeded'] === true,
    externalEvidenceLikelyNeeded: retrieval['externalEvidenceLikelyNeeded'] === true,
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function text(value: unknown, fallback: string): string {
  return string(value) ?? fallback
}

function strings(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
      const itemRecord = record(item)
      return itemRecord === undefined ? [] : [itemRecord]
    })
    : []
}

function planData(event: SessionEventLike): PlanData {
  const data = record(event.data) ?? {}
  return {
    revision: typeof data['revision'] === 'number' ? data['revision'] : 1,
    objective: text(data['objective'], ''),
    approach: text(data['approach'], ''),
    playbooks: strings(data['playbooks']).flatMap((playbook) => {
      const id = string(playbook['id'])
      const reason = string(playbook['reason'])
      return id === undefined || reason === undefined ? [] : [{ id, reason }]
    }),
    workstreams: strings(data['workstreams']).flatMap((workstream) => {
      const id = string(workstream['id'])
      const actor = record(workstream['actor']) ?? {}
      const actorKind = string(actor['kind'])
      const employeeId = string(actor['employeeId'])
      const role = string(actor['role'])
      const objective = string(workstream['objective'])
      return id === undefined || actorKind === undefined || objective === undefined ? [] : [{
        id,
        objective,
        actorKind,
        status: 'queued' as const,
        ...(employeeId === undefined ? {} : { employeeId }),
        ...(role === undefined ? {} : { role }),
      }]
    }),
  }
}

function updatePlanWorkstream(plan: PlanData, event: SessionEventLike): PlanData {
  const data = record(event.data) ?? {}
  const workstreamId = string(data['workstreamId'])
  if (workstreamId === undefined) return plan
  const actor = record(data['actor']) ?? {}
  const status: OperatingWorkstreamStatus = event.type === 'hivemind/workstream-completed'
    ? 'completed'
    : event.type === 'hivemind/workstream-failed'
      ? 'failed'
      : 'running'
  const summary = string(data['summary']) ?? string(data['diagnostic'])
  const employeeId = string(actor['employeeId'])
  const actorName = string(actor['employeeName'])
  const role = string(actor['role'])
  const avatarUrl = string(actor['avatarUrl'])
  return {
    ...plan,
    workstreams: plan.workstreams.map(workstream => workstream.id !== workstreamId ? workstream : {
      ...workstream,
      status,
      actorKind: string(actor['kind']) ?? workstream.actorKind,
      ...(employeeId === undefined ? {} : { employeeId }),
      ...(actorName === undefined ? {} : { actorName }),
      ...(role === undefined ? {} : { role }),
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      ...(summary === undefined ? {} : { summary }),
    }),
  }
}

function methodsData(event: SessionEventLike): MethodsData {
  const data = record(event.data) ?? {}
  return {
    methods: strings(data['playbooks']).flatMap(playbook => string(playbook['id']) ?? []),
  }
}

function workstreamIdentity(event: SessionEventLike): string | undefined {
  return string(record(event.data)?.['workstreamId'])
}

function workstreamStart(event: SessionEventLike): WorkstreamData {
  const data = record(event.data) ?? {}
  const actor = record(data['actor']) ?? {}
  const actorName = string(actor['employeeName'])
  const employeeId = string(actor['employeeId'])
  const role = string(actor['role'])
  const avatarUrl = string(actor['avatarUrl'])
  return {
    objective: text(data['objective'], ''),
    actorKind: text(actor['kind'], 'main'),
    status: 'running',
    approvalRequired: data['approvalRequired'] === true,
    ...(employeeId === undefined ? {} : { employeeId }),
    ...(actorName === undefined ? {} : { actorName }),
    ...(role === undefined ? {} : { role }),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
  }
}

function requestedResearch(event: SessionEventLike): ResearchData {
  const data = record(event.data) ?? {}
  return {
    objective: text(data['objective'], ''),
    type: text(data['type'], ''),
    status: text(data['status'], 'queued'),
    evidenceState: 'queued',
    sourceCount: 0,
  }
}

function employeeStart(event: SessionEventLike): EmployeeData {
  const data = record(event.data) ?? {}
  return {
    employeeId: text(data['employeeId'], 'employee'),
    employeeName: text(data['employeeName'], ''),
    role: text(data['role'], ''),
    task: text(data['task'], ''),
    status: string(data['executionState']) === 'pending' ? 'waiting' : 'running',
    acceptanceCriteria: Array.isArray(data['acceptanceCriteria'])
      ? data['acceptanceCriteria'].flatMap(item => string(item) ?? [])
      : [],
    playbooks: strings(data['selectedPlaybooks']).flatMap(playbook => string(playbook['id']) ?? []),
  }
}

const ROLE_COLORS: Readonly<Record<string, string>> = {
  strategist: '#a855f7',
  coordinator: '#a855f7',
  builder: '#117dff',
  skeptic: '#f59e0b',
  investigator: '#10b981',
  researcher: '#10b981',
  generalist: '#ec4899',
  communicator: '#ec4899',
}

/** The same deterministic Humation identity used by the HIVE employee surfaces. */
function EmployeeAvatar({
  active,
  avatarUrl,
  employeeId,
  name,
  role,
  size = 32,
}: {
  readonly active: boolean
  readonly avatarUrl?: string
  readonly employeeId: string
  readonly name: string
  readonly role?: string
  readonly size?: number
}) {
  const color = ROLE_COLORS[(role ?? '').toLowerCase()] ?? '#117dff'
  return (
    <span
      className={css.avatar}
      data-active={active ? 'true' : 'false'}
      style={{
        width: size,
        height: size,
        borderColor: color,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}
      title={role === undefined ? name : `${name} · ${role}`}
    >
      {avatarUrl !== undefined && /^https?:\/\//.test(avatarUrl) ? (
        <img src={avatarUrl} alt="" />
      ) : (
        <Avatar
          assets={humation1}
          seed={employeeId || name || 'employee'}
          size={size}
          colors={{ clothes: color }}
          background="transparent"
          title={name}
        />
      )}
    </span>
  )
}

function researchIdentity(event: SessionEventLike): string | undefined {
  return string(record(event.data)?.['jobId'])
}

function delegationIdentity(event: SessionEventLike): string | undefined {
  return string(record(event.data)?.['delegationId'])
}

function receiptIdentity(event: SessionEventLike): string | undefined {
  return string(record(event.data)?.['receiptId'])
}

function receiptData(event: SessionEventLike): ReceiptData {
  const data = record(event.data) ?? {}
  const status = string(data['status'])
  const toolName = string(data['toolName'])
  const summary = string(data['summary'])
  return {
    kind: text(data['kind'], 'receipt'),
    title: text(data['title'], 'Native receipt'),
    status: status === 'running' || status === 'failed' ? status : 'completed',
    ...(toolName === undefined ? {} : { toolName }),
    ...(summary === undefined ? {} : { summary }),
  }
}

function evaluationData(event: SessionEventLike): EvaluationData {
  const data = record(event.data) ?? {}
  const counts = record(data['receiptCounts']) ?? {}
  return {
    receiptCounts: Object.entries(counts).flatMap(([kind, count]) =>
      typeof count === 'number' ? [{ kind, count }] : [],
    ),
    next: text(data['next'], ''),
  }
}

function artifactData(event: SessionEventLike): ArtifactData {
  const data = record(event.data) ?? {}
  const file = record(data['pdf'] ?? data['file'])
  const preview = record(data['preview']) ?? {}
  const previewName = string(preview['name'])
  return {
    title: text(data['title'], 'Rendered document'),
    path: text(data['path'], String(event.type) === 'hivemind/browser-capture' ? text(file?.['name'], 'Website screenshot.png') : ''),
    provider: text(data['provider'], ''),
    mediaType: text(data['mediaType'], String(event.type) === 'hivemind/browser-capture' ? 'image/png' : 'application/pdf'),
    pageSize: string(data['pageSize']) === 'Letter' ? 'Letter' : 'A4',
    pageCount: typeof data['pageCount'] === 'number' ? data['pageCount'] : 0,
    pdfBytes: typeof data['pdfBytes'] === 'number' ? data['pdfBytes'] : Number(record(data['file'])?.['bytes'] ?? 0),
    ...(typeof file?.['attachmentId'] === 'string' && typeof file['name'] === 'string' && typeof file['bytes'] === 'number'
      ? { file: { attachmentId: file['attachmentId'] as FileAttachmentRef['attachmentId'], name: file['name'], bytes: file['bytes'] } }
      : {}),
    ...(data['preview'] === undefined
      ? {}
      : {
        preview: {
          attachmentId: text(preview['attachmentId'], '') as ImageAttachmentRef['attachmentId'],
          mediaType: preview['mediaType'] === 'image/jpeg' ? 'image/jpeg' : preview['mediaType'] === 'image/webp' ? 'image/webp' : 'image/png',
          bytes: typeof preview['bytes'] === 'number' ? preview['bytes'] : 0,
          width: typeof preview['width'] === 'number' ? preview['width'] : 0,
          height: typeof preview['height'] === 'number' ? preview['height'] : 0,
          ...(previewName === undefined ? {} : { name: previewName }),
        },
      }),
  }
}

const planDefinition: ConversationNodeDefinition<PlanData> = {
  kind: 'hivemind-operating-plan',
  target: 'chat',
  match: (event) => {
    const id = string(record(event.data)?.['planId'])
    if (id === undefined) return event.type === 'hivemind/run-plan' ? { id: String(event.seq), role: 'start' } : null
    if (event.type === 'hivemind/run-plan') return { id, role: 'start' }
    return event.type === 'hivemind/run-plan-revised' ||
      event.type === 'hivemind/workstream-started' ||
      event.type === 'hivemind/workstream-progress' ||
      event.type === 'hivemind/workstream-approval' ||
      event.type === 'hivemind/workstream-completed' ||
      event.type === 'hivemind/workstream-failed'
      ? { id, role: 'update' }
      : null
  },
  start: (_context, match) => planData(match.event),
  update: (context, match) => match.event.type === 'hivemind/run-plan-revised'
    ? planData(match.event)
    : updatePlanWorkstream(context.state, match.event),
  buildViewNode: context =>
    context.start === undefined
      ? null
      : {
        key: context.key,
        kind: 'hivemind-operating-plan',
        id: context.id,
        target: 'chat',
        anchorSeq: context.start.event.seq,
        location: context.start.location,
        visibility: 'visible',
        data: context.state,
      },
}

const operatingContextDefinition: ConversationNodeDefinition<OperatingContextData> = {
  kind: 'hivemind-operating-context',
  target: 'chat',
  match: event =>
    event.type === 'hivemind/operating-context'
      ? { id: string(record(event.data)?.['runId']) ?? String(event.seq), role: 'start' }
      : null,
  start: (_context, match) => operatingContextData(match.event),
  update: (_context, match) => operatingContextData(match.event),
  buildViewNode: context =>
    context.start === undefined
      ? null
      : {
        key: context.key,
        kind: 'hivemind-operating-context',
        id: context.id,
        target: 'chat',
        anchorSeq: context.start.event.seq,
        location: context.start.location,
        visibility: 'visible',
        data: context.state,
      },
}

interface AssistantPresentationData {
  readonly reasoning: 'trajectory-only'
  readonly turn?: number
  readonly ownsTurn: boolean
}

const assistantPresentationDefinition: ConversationNodeDefinition<AssistantPresentationData> = {
  kind: 'assistant-presentation',
  match: event =>
    event.type === 'hivemind/operating-context'
      ? { id: string(record(event.data)?.['runId']) ?? String(event.seq), role: 'start' }
      : null,
  // Company mode keeps private reasoning in Trajectory without gating answers
  // on a plan receipt or changing the native Harness execution lifecycle.
  start: (_context, match, reader) => {
    const location = match.location
    const turn = location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
    const previous = reader.previous<AssistantPresentationData>('assistant-presentation')?.state
    return { reasoning: 'trajectory-only', ...(turn === undefined ? {} : { turn }), ownsTurn: turn !== undefined && previous?.turn !== turn }
  },
  update: context => context.state,
  buildLocationData: (context, scope) => {
    if (scope !== 'turn' || context.start === undefined || context.state === undefined || !context.state.ownsTurn) return null
    const location = context.start.location
    if (location.kind !== 'turn' && location.kind !== 'step') return null
    return {
      kind: 'turn',
      turn: location.turn.turn,
      key: 'assistant-presentation',
      value: context.state,
    }
  },
}

const methodsDefinition: ConversationNodeDefinition<MethodsData> = {
  kind: 'hivemind-operating-methods',
  target: 'chat',
  match: event =>
    event.type === 'hivemind/playbooks-loaded'
      ? { id: string(record(event.data)?.['runId']) ?? String(event.seq), role: 'start' }
      : null,
  start: (_context, match) => methodsData(match.event),
  update: context => context.state,
  buildViewNode: context =>
    context.start === undefined
      ? null
      : {
        key: context.key,
        kind: 'hivemind-operating-methods',
        id: context.id,
        target: 'chat',
        anchorSeq: context.start.event.seq,
        location: context.start.location,
        visibility: 'visible',
        data: context.state,
      },
}

const workstreamDefinition: ConversationNodeDefinition<WorkstreamData> = {
  kind: 'hivemind-operating-workstream',
  target: 'chat',
  match: (event) => {
    const id = workstreamIdentity(event)
    if (id === undefined) return null
    if (event.type === 'hivemind/workstream-started') return { id, role: 'start' }
    return event.type === 'hivemind/workstream-progress' ||
      event.type === 'hivemind/workstream-approval' ||
      event.type === 'hivemind/workstream-completed' ||
      event.type === 'hivemind/workstream-failed'
      ? { id, role: 'update' }
      : null
  },
  start: (_context, match) => workstreamStart(match.event),
  update: (context, match) => {
    const data = record(match.event.data) ?? {}
    if (match.event.type === 'hivemind/workstream-approval') {
      const outcome = string(data['outcome'])
      const approvalStatus: WorkstreamData['approvalStatus'] =
        outcome === 'allowed-once'
          ? 'approved'
          : outcome === 'rejected'
            ? 'rejected'
            : outcome === 'cancelled'
              ? 'cancelled'
              : 'unavailable'
      return { ...context.state, approvalStatus }
    }
    const summary = string(data['summary']) ?? string(data['diagnostic'])
    const status =
      match.event.type === 'hivemind/workstream-completed'
        ? 'completed'
        : match.event.type === 'hivemind/workstream-failed'
          ? 'failed'
          : 'running'
    return { ...context.state, status, ...(summary === undefined ? {} : { summary }) }
  },
  buildViewNode: context =>
    context.start === undefined
      ? null
      : {
        key: context.key,
        kind: 'hivemind-operating-workstream',
        id: context.id,
        target: 'chat',
        anchorSeq: context.start.event.seq,
        location: context.start.location,
        visibility: 'visible',
        data: context.state,
      },
}

const researchDefinition: ConversationNodeDefinition<ResearchData> = {
  kind: 'hivemind-operating-research',
  target: 'chat',
  match: (event) => {
    const id = researchIdentity(event)
    if (id === undefined) return null
    if (event.type === 'hivemind/research-requested') return { id, role: 'start' }
    return event.type === 'hivemind/research-receipt' ? { id, role: 'update' } : null
  },
  start: (_context, match) => requestedResearch(match.event),
  update: (context, match) => {
    if (match.event.type !== 'hivemind/research-receipt') return context.state
    const receipt = record(match.event.data) ?? {}
    const evidence = string(receipt['evidenceState'])
    const evidenceState: ResearchData['evidenceState'] =
      evidence === 'ready' || evidence === 'partial' || evidence === 'unavailable' || evidence === 'pending'
        ? evidence === 'pending'
          ? 'waiting'
          : evidence
        : 'failed'
    const provider = string(receipt['provider'])
    return {
      ...context.state,
      status: text(receipt['status'], context.state.status),
      evidenceState,
      sourceCount: strings(receipt['sources']).length,
      ...(provider === undefined ? {} : { provider }),
    }
  },
  buildViewNode: context =>
    context.start === undefined
      ? null
      : {
        key: context.key,
        kind: 'hivemind-operating-research',
        id: context.id,
        target: 'chat',
        anchorSeq: context.start.event.seq,
        location: context.start.location,
        visibility: 'visible',
        data: context.state,
      },
}

const employeeDefinition: ConversationNodeDefinition<EmployeeData> = {
  kind: 'hivemind-operating-employee',
  target: 'chat',
  match: (event) => {
    const id = delegationIdentity(event)
    if (id === undefined) return null
    if (event.type === 'hivemind/employee-delegation-start') return { id, role: 'start' }
    return event.type === 'hivemind/employee-delegation-end' ? { id, role: 'update' } : null
  },
  start: (_context, match) => employeeStart(match.event),
  update: (context, match) => {
    if (match.event.type !== 'hivemind/employee-delegation-end') return context.state
    const end = record(match.event.data) ?? {}
    const status = string(end['status'])
    const childSessionId = string(end['childSessionId'])
    const diagnostic = string(end['diagnostic'])
    const outputPreview = string(end['outputPreview'])
    return {
      ...context.state,
      status: status === 'completed' ? 'completed' : 'failed',
      ...(childSessionId === undefined ? {} : { childSessionId }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(outputPreview === undefined ? {} : { outputPreview }),
    }
  },
  buildViewNode: context =>
    context.start === undefined
      ? null
      : {
        key: context.key,
        kind: 'hivemind-operating-employee',
        id: context.id,
        target: 'chat',
        anchorSeq: context.start.event.seq,
        location: context.start.location,
        visibility: 'visible',
        data: context.state,
      },
}

const receiptDefinition: ConversationNodeDefinition<ReceiptData> = {
  kind: 'hivemind-operating-receipt',
  target: 'chat',
  match: (event) => {
    const observed = event as unknown as { readonly type: string; readonly data: unknown; readonly seq: number }
    if (observed.type !== 'hivemind/operating-receipt') return null
    const id = receiptIdentity(observed as unknown as SessionEventLike)
    return id === undefined ? null : { id, role: 'start' }
  },
  start: (_context, match) => receiptData(match.event as unknown as SessionEventLike),
  update: (_context, match) => receiptData(match.event as unknown as SessionEventLike),
  buildViewNode: context =>
    context.start === undefined
      ? null
      : {
        key: context.key,
        kind: 'hivemind-operating-receipt',
        id: context.id,
        target: 'chat',
        anchorSeq: context.start.event.seq,
        location: context.start.location,
        visibility: 'visible',
        data: context.state,
      },
}

const evaluationDefinition: ConversationNodeDefinition<EvaluationData> = {
  kind: 'hivemind-operating-evaluation',
  target: 'chat',
  match: (event) => {
    const observed = event as unknown as { readonly type: string; readonly data: unknown; readonly seq: number }
    return observed.type === 'hivemind/run-evaluation'
      ? { id: string(record(observed.data)?.['runId']) ?? String(observed.seq), role: 'start' }
      : null
  },
  start: (_context, match) => evaluationData(match.event as unknown as SessionEventLike),
  update: (_context, match) => evaluationData(match.event as unknown as SessionEventLike),
  buildViewNode: context =>
    context.start === undefined
      ? null
      : {
        key: context.key,
        kind: 'hivemind-operating-evaluation',
        id: context.id,
        target: 'chat',
        anchorSeq: context.start.event.seq,
        location: context.start.location,
        visibility: 'visible',
        data: context.state,
      },
}

const artifactDefinition: ConversationNodeDefinition<ArtifactData> = {
  kind: 'hivemind-artifact',
  target: 'chat',
  match: event =>
    event.type === 'hivemind/artifact-created' || event.type === 'hivemind/generation-created' || (String(event.type) === 'hivemind/browser-capture' && typeof record(record(event.data)?.['preview'])?.['attachmentId'] === 'string')
      ? { id: string(record(event.data)?.['artifactId'] ?? record(event.data)?.['captureId']) ?? String(event.seq), role: 'start' }
      : null,
  start: (_context, match) => artifactData(match.event),
  update: context => context.state,
  buildViewNode: context =>
    context.start === undefined
      ? null
      : {
        key: context.key,
        kind: 'hivemind-artifact',
        id: context.id,
        target: 'chat',
        processDisclosure: 'independent',
        anchorSeq: (() => {
          if (String(context.start.event.type) === 'hivemind/browser-capture') return context.start.event.seq
          const location = context.start.location
          const closing = location.kind === 'turn' || location.kind === 'step' ? location.turn.data.get('turn-tail')?.closing : undefined
          return closing ? closing.finalNode.seq + 0.075 : context.start.event.seq
        })(),
        location: context.start.location,
        visibility: 'visible',
        data: context.state,
      },
}

function mediaWorkflowData(event: SessionEventLike, previous?: MediaWorkflowData): MediaWorkflowData {
  const data = record(event.data) ?? {}
  const terminal = String(event.type) === 'hivemind/media-workflow-ended'
  const rawStatus = string(data['status'])
  const diagnostic = string(data['diagnostic'])
  return {
    ...(typeof data['startedAt'] === 'number' ? { startedAt: data['startedAt'] } : {}),
    kind: string(data['kind']) ?? previous?.kind ?? 'media',
    title: string(data['title']) ?? previous?.title ?? '',
    provider: string(data['provider']) ?? previous?.provider ?? '',
    status: terminal ? (rawStatus === 'completed' ? 'completed' : 'failed') : 'running',
    ...(typeof data['attempts'] === 'number' ? { attempts: data['attempts'] } : {}),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  }
}

const mediaWorkflowDefinition: ConversationNodeDefinition<MediaWorkflowData> = {
  kind: 'hivemind-media-workflow',
  target: 'chat',
  match: (event) => {
    const observed = event as unknown as SessionEventLike
    if (String(observed.type) !== 'hivemind/media-workflow-started' && String(observed.type) !== 'hivemind/media-workflow-ended') return null
    const id = string(record(observed.data)?.['workflowId'])
    if (!id) return null
    return { id, role: String(observed.type) === 'hivemind/media-workflow-started' ? 'start' : 'update' }
  },
  start: (_context, match) => mediaWorkflowData(match.event),
  update: (context, match) => mediaWorkflowData(match.event, context.state),
  buildViewNode: context => context.start === undefined ? null : {
    key: context.key, kind: 'hivemind-media-workflow', id: context.id, target: 'chat',
    anchorSeq: context.start.event.seq, location: context.start.location, visibility: 'visible', data: context.state,
  },
}

export const operatingRunDefinitions = [
  operatingContextDefinition,
  assistantPresentationDefinition,
  methodsDefinition,
  planDefinition,
  workstreamDefinition,
  researchDefinition,
  employeeDefinition,
  receiptDefinition,
  evaluationDefinition,
  artifactDefinition,
  mediaWorkflowDefinition,
] as const

type PanelProps<K extends keyof import('@deepseek-ai/dsh-client-ui-chat/client').ChatNodeDataMap> = PropsRuntime<
  'conversation.chat.node',
  K
> &
  PropsLocale<'hivemindOperatingRun'>

function Card({
  children,
  state,
  statusText,
  title,
}: {
  readonly children: ReactNode
  readonly state: string
  readonly statusText: string
  readonly title: string
}) {
  return (
    <section className={css.card} data-hivemind-operating-run={state}>
      <header className={css.header}>
        <span className={css.title}>{title}</span>
        <span className={css.status} data-state={state}>
          {statusText}
        </span>
      </header>
      {children}
    </section>
  )
}

function PlanPanel({ node, t }: PanelProps<'hivemind-operating-plan'>) {
  const workstreams = node.data.workstreams
  const state: OperatingWorkstreamStatus = workstreams.some(item => item.status === 'running')
    ? 'running'
    : workstreams.length > 0 && workstreams.every(item => item.status === 'completed')
      ? 'completed'
      : workstreams.some(item => item.status === 'failed')
        ? 'failed'
        : 'queued'
  return (
    <Card title={t('plan.title')} state={state} statusText={t(`state.${state}` as OperatingRunKey)}>
      <div className={css.objective}>{node.data.objective}</div>
      <div className={css.playbooks} aria-label={t('plan.playbooks')}>
        {node.data.playbooks.map(playbook => (
          <span key={playbook.id} className={css.chip} title={playbook.reason}>
            {playbook.id}
          </span>
        ))}
      </div>
      <div className={css.detail}>{node.data.approach}</div>
      {workstreams.length === 0 ? null : (
        <div className={css.team} aria-label={t('plan.team')}>
          <div className={css.sectionLabel}>{t('plan.team')}</div>
          {workstreams.map((item) => {
            const employeeId = item.employeeId
            const employee = employeeId !== undefined
            const displayName = item.actorName ?? item.role ?? (employee ? t('plan.employee') : t('plan.runtime'))
            return (
              <div className={css.teamMember} data-state={item.status} key={item.id}>
                {employee ? (
                  <EmployeeAvatar
                    active={item.status === 'running'}
                    employeeId={employeeId}
                    name={displayName}
                    {...(item.avatarUrl === undefined ? {} : { avatarUrl: item.avatarUrl })}
                    {...(item.role === undefined ? {} : { role: item.role })}
                  />
                ) : <span className={css.runtimeAvatar} aria-hidden="true">{t('plan.runtimeMark')}</span>}
                <div className={css.employeeCopy}>
                  <div className={css.memberHeader}>
                    <span className={css.memberName}>{displayName}</span>
                    <span className={css.memberStatus} data-state={item.status}>
                      {t(`state.${item.status}` as OperatingRunKey)}
                    </span>
                  </div>
                  <div className={css.memberObjective}>{item.objective}</div>
                  {item.summary === undefined ? null : <div className={css.memberSummary}>{item.summary}</div>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function OperatingContextPanel({ node, t }: PanelProps<'hivemind-operating-context'>) {
  return (
    <Card title={t('context.title')} state="ready" statusText={t('state.ready')}>
      <div className={css.objective}>{t('context.coverage')}</div>
      <div className={css.meta}>
        <span>{t('context.evidence', { count: node.data.evidenceCount })}</span>
        <span>{t('context.employees', { count: node.data.employeeCount })}</span>
        <span className={css.chip}>{t('context.playbooks', { count: node.data.playbookCount })}</span>
      </div>
    </Card>
  )
}

function MethodsPanel({ node, t }: PanelProps<'hivemind-operating-methods'>) {
  return (
    <Card title={t('methods.title')} state="completed" statusText={t('state.completed')}>
      <div className={css.playbooks} aria-label={t('methods.loaded')}>
        {node.data.methods.map(method => (
          <span key={method} className={css.chip}>
            {method}
          </span>
        ))}
      </div>
    </Card>
  )
}

function WorkstreamPanel({ node, t }: PanelProps<'hivemind-operating-workstream'>) {
  return (
    <Card
      title={t('workstream.title')}
      state={node.data.status}
      statusText={t(`state.${node.data.status}` as OperatingRunKey)}
    >
      <div className={css.employeeRow}>
        {node.data.actorName === undefined ? null : (
          <EmployeeAvatar
            active={node.data.status === 'running'}
            employeeId={node.data.employeeId ?? node.data.actorName}
            name={node.data.actorName}
            {...(node.data.avatarUrl === undefined ? {} : { avatarUrl: node.data.avatarUrl })}
            {...(node.data.role === undefined ? {} : { role: node.data.role })}
          />
        )}
        <div className={css.employeeCopy}>
          <div className={css.objective}>{node.data.objective}</div>
          <div className={css.meta}>
            <span className={css.chip}>{node.data.actorKind}</span>
            {node.data.actorName === undefined ? null : <span>{node.data.actorName}</span>}
            {node.data.role === undefined ? null : <span>{node.data.role}</span>}
          </div>
          {node.data.approvalRequired ? (
            <div className={css.meta}>
              <span className={css.chip}>{t('approval.label', {
                status: t(`approval.${node.data.approvalStatus ?? 'required'}` as OperatingRunKey),
              })}</span>
            </div>
          ) : null}
        </div>
      </div>
      {node.data.summary === undefined ? null : <div className={css.output}>{node.data.summary}</div>}
    </Card>
  )
}

function ResearchPanel({ node, t }: PanelProps<'hivemind-operating-research'>) {
  const state = node.data.evidenceState
  return (
    <Card title={t('research.title')} state={state} statusText={t(`state.${state}` as OperatingRunKey)}>
      <div className={css.objective}>{node.data.objective}</div>
      <div className={css.meta}>
        <span className={css.chip}>{node.data.type}</span>
        <span>{t('research.sources', { count: node.data.sourceCount })}</span>
        {node.data.provider === undefined ? null : (
          <span>{t('research.provider', { provider: node.data.provider })}</span>
        )}
      </div>
    </Card>
  )
}

function EmployeePanel({ node, t }: PanelProps<'hivemind-operating-employee'>) {
  return (
    <Card
      title={t('employee.title')}
      state={node.data.status}
      statusText={t(`state.${node.data.status}` as OperatingRunKey)}
    >
      <div className={css.employeeRow}>
        <EmployeeAvatar
          active={node.data.status === 'running'}
          employeeId={node.data.employeeId}
          name={node.data.employeeName}
          role={node.data.role}
        />
        <div className={css.employeeCopy}>
          <div className={css.objective}>{node.data.employeeName}</div>
          <div className={css.meta}>
            <span>{t('employee.role', { role: node.data.role })}</span>
            {node.data.childSessionId === undefined ? null : <span>{t('employee.child')}</span>}
          </div>
        </div>
      </div>
      {node.data.playbooks.length === 0 ? null : (
        <div className={css.playbooks}>
          {node.data.playbooks.map(playbook => (
            <span className={css.chip} key={playbook}>
              {playbook}
            </span>
          ))}
        </div>
      )}
      <div className={css.detail}>
        {node.data.task.length > 320 ? `${node.data.task.slice(0, 317)}…` : node.data.task}
      </div>
      {node.data.acceptanceCriteria.length === 0 ? null : (
        <div className={css.criteria}>{node.data.acceptanceCriteria.join(' · ')}</div>
      )}
      {node.data.status === 'failed' ? (
        <div className={css.output}>{node.data.diagnostic ?? t('employee.failed')}</div>
      ) : node.data.outputPreview === undefined ? null : (
        <div className={css.output}>{node.data.outputPreview}</div>
      )}
    </Card>
  )
}

function ReceiptPanel({ node, t }: PanelProps<'hivemind-operating-receipt'>) {
  return (
    <Card
      title={t('receipt.title')}
      state={node.data.status}
      statusText={t(`state.${node.data.status}` as OperatingRunKey)}
    >
      <div className={css.objective}>{node.data.title}</div>
      <div className={css.meta}>
        <span className={css.chip}>{node.data.kind}</span>
        {node.data.toolName === undefined ? null : <span>{node.data.toolName}</span>}
      </div>
      {node.data.summary === undefined ? null : <div className={css.output}>{node.data.summary}</div>}
    </Card>
  )
}

function EvaluationPanel({ node, t }: PanelProps<'hivemind-operating-evaluation'>) {
  return (
    <Card title={t('evaluation.title')} state="ready" statusText={t('state.ready')}>
      {node.data.receiptCounts.length === 0 ? null : (
        <div className={css.playbooks}>
          {node.data.receiptCounts.map(item => (
            <span key={item.kind} className={css.chip}>
              {item.kind}: {item.count}
            </span>
          ))}
        </div>
      )}
      <div className={css.detail}>{node.data.next}</div>
    </Card>
  )
}

function ArtifactTypeIcon({ mediaType, name }: { mediaType: string; name: string }) {
  const image = mediaType.startsWith('image/')
  const label = image ? 'Image' : mediaType === 'application/pdf' ? 'PDF' : /\.pptx?$/i.test(name) ? 'Presentation' : /\.docx?$/i.test(name) ? 'Document' : /\.md$/i.test(name) || mediaType === 'text/markdown' ? 'Markdown' : 'File'
  return <span className={css.artifactFileIcon} title={label}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" role="img" aria-label={label}>
    {image ? <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></> : <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" /><text x="12" y="17" textAnchor="middle" stroke="none" fill="currentColor" fontSize="6" fontWeight="700">{label === 'PDF' ? 'PDF' : label === 'Presentation' ? 'P' : label === 'Markdown' ? 'MD' : label === 'Document' ? 'DOC' : 'FILE'}</text></>}
  </svg></span>
}

const presentedArtifacts = new Set<string>()

function ArtifactThumbnail({ attachment, load, title, unavailable }: {
  attachment: ImageAttachmentRef
  load: (ref: ImageAttachmentRef) => Promise<string>
  title: string
  unavailable: string
}) {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    let active = true
    setUrl(undefined); setFailed(false)
    void loadRef.current(attachment).then((value) => { if (active) setUrl(value) }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [attachment.attachmentId])
  if (failed) return <p role="status">{unavailable}</p>
  return url ? <img src={url} alt={title} style={{ width: '100%', height: 'auto' }} onError={() => { setFailed(true) }} /> : null
}

function ArtifactPanel({ sessionId, node, t, read, loadImage, openPreview }: PanelProps<'hivemind-artifact'> & { read: (id: FileAttachmentRef['attachmentId']) => Promise<{ ok: boolean; value?: { attachment: FileAttachmentRef; data: string } }> ; loadImage: (ref: ImageAttachmentRef) => Promise<string>; openPreview: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (node.data.file === undefined) return
    const key = `${sessionId}:${node.id}`
    if (presentedArtifacts.has(key)) return
    presentedArtifacts.add(key)
    openPreview()
  }, [sessionId, node.id, node.data.file?.attachmentId, openPreview])
  return (
    <div className={css.artifactResult}>
      {node.data.preview === undefined ? null : <div className={css.artifactHeroImage}><ArtifactThumbnail attachment={node.data.preview} load={loadImage} title={node.data.title} unavailable={t('artifact.thumbnailUnavailable')} /></div>}
      <div className={css.artifactFileRow}>
        <button type="button" className={css.artifactFilePreview} onClick={openPreview} disabled={node.data.file === undefined}>
          <ArtifactTypeIcon mediaType={node.data.mediaType} name={node.data.file?.name ?? node.data.title} />
          <span><strong>{node.data.file?.name ?? node.data.title}</strong><small>{t('artifact.preview')}</small></span>
        </button>
        <button
          type="button"
          className={css.artifactAction}
          disabled={busy || node.data.file === undefined}
          onClick={async () => {
            setBusy(true)
            setFailed(false)
            try {
              if (node.data.file === undefined) throw new Error('Artifact file receipt missing')
              const result = await read(node.data.file.attachmentId)
              if (!result.ok || result.value?.attachment.attachmentId !== node.data.file.attachmentId) throw new Error('Artifact download failed')
              saveArtifact(fileArtifactBlob(result.value.data, node.data.mediaType, node.data.file.bytes), node.data.file.name)
            } catch {
              setFailed(true)
            } finally {
              setBusy(false)
            }
          }}
        >
          {t(busy ? 'artifact.downloading' : 'artifact.open')}
        </button>
      </div>
      {failed ? <div role="alert">{t('artifact.failed')}</div> : null}
    </div>
  )
}

function MediaWorkflowPanel({ node, t }: PanelProps<'hivemind-media-workflow'>) {
  if (node.data.status === 'completed') return null
  return (
    <Card title={t('media.title')} state={node.data.status} statusText={t(`state.${node.data.status}` as OperatingRunKey)}>
      <div className={css.objective}>{node.data.title || t('media.title')}</div>
      {node.data.status === 'running'
        ? <ImageProgress startedAt={node.data.startedAt} label={t('media.progress')} /> : null}
      <div className={css.meta}>
        <span className={css.chip}>{node.data.kind.toUpperCase()}</span>
        <span>{node.data.provider || t('media.providerUnknown')}</span>
        {node.data.attempts === undefined ? null : <span>{t('media.attempts', { count: node.data.attempts })}</span>}
      </div>
      {node.data.diagnostic === undefined ? null : <div className={css.output}>{node.data.diagnostic}</div>}
    </Card>
  )
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    'hivemind-artifact': { artifact: ArtifactData }
  }
}

function ArtifactPreview({ useTabInfo, t, read }: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS> & {
  read: (id: FileAttachmentRef['attachmentId']) => Promise<{ ok: boolean; value?: { attachment: FileAttachmentRef; data: string } }>
}) {
  const info = useTabInfo()
  const params = info.tab.navigation.params as { artifact: ArtifactData } | undefined
  const artifact = params?.artifact
  const [url, setUrl] = useState<string>()
  const [text, setText] = useState<string>()
  const [failed, setFailed] = useState(false)
  const file = artifact?.file
  useEffect(() => {
    let active = true
    let created: string | undefined
    setUrl(undefined); setText(undefined); setFailed(false)
    if (file) void read(file.attachmentId).then(async (result) => {
      if (!result.ok || result.value?.attachment.attachmentId !== file.attachmentId) throw new Error('Artifact unavailable')
      const blob = fileArtifactBlob(result.value.data, artifact?.mediaType ?? 'application/octet-stream', file.bytes)
      if (artifact?.mediaType.startsWith('text/') && artifact.mediaType !== 'text/html') {
        const value = await blob.text()
        if (active) setText(value)
      } else {
        created = URL.createObjectURL(blob)
        if (active) setUrl(created)
        else URL.revokeObjectURL(created)
      }
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false; if (created) URL.revokeObjectURL(created) }
  }, [file?.attachmentId])
  if (!artifact) return null
  return <div className={css.artifactPreviewBody}><h3>{artifact.title}</h3>
    {failed ? <p role="alert">{t('artifact.failed')}</p> : null}
    {text !== undefined ? <pre>{text}</pre> : null}
    {url && artifact.mediaType.startsWith('image/') ? <img src={url} alt={artifact.title} />
      : url && artifact.mediaType.startsWith('video/') ? <video src={url} controls />
        : url && (artifact.mediaType === 'application/pdf' || artifact.mediaType === 'text/html') ? <iframe src={url} title={artifact.title} sandbox="" /> : null}
    {url ? <a href={url} download={file?.name}>{t('artifact.open')}</a> : null}
  </div>
}

/** Required browser services for operating-run Definitions and native Chat renderers. */
export const inject = ['sidebarRightTabs', 'uiConversation', 'slots', 'locale', 'remote', 'remote.session', 'sidebarRight']

/** Register durable event projections; sessions lacking HIVE events produce no nodes. */
export function apply(ctx: ClientContext): void {
  const previewKey = 'hivemind-artifact-preview'
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: previewKey, kind: previewKey, patterns: ['dsh-resource://hivemind-artifact/**'], title: () => ctx.locale.bind(NS)('artifact.preview') }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: previewKey, locale: NS }, props => <ArtifactPreview {...props} read={attachmentId => ctx.remote.session.fileAttachment({ sessionId: props.sessionId, attachmentId })} />))
  for (const definition of operatingRunDefinitions) ctx.uiConversation.events.register(definition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-hivemind-operating-run: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => [
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'hivemind-operating-context', locale: NS },
      OperatingContextPanel,
    ),
    ctx.slots.register({ name: 'conversation.chat.node', key: 'hivemind-operating-methods', locale: NS }, MethodsPanel),
    ctx.slots.register({ name: 'conversation.chat.node', key: 'hivemind-operating-plan', locale: NS }, PlanPanel),
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'hivemind-operating-workstream', locale: NS },
      WorkstreamPanel,
    ),
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'hivemind-operating-research', locale: NS },
      ResearchPanel,
    ),
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'hivemind-operating-employee', locale: NS },
      EmployeePanel,
    ),
    ctx.slots.register({ name: 'conversation.chat.node', key: 'hivemind-operating-receipt', locale: NS }, ReceiptPanel),
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'hivemind-operating-evaluation', locale: NS },
      EvaluationPanel,
    ),
    ctx.slots.register({ name: 'conversation.chat.node', key: 'hivemind-artifact', locale: NS }, props => (
      <ArtifactPanel
        {...props}
        read={attachmentId => ctx.remote.session.fileAttachment({ sessionId: props.sessionId, attachmentId })}
        loadImage={ref => ctx.uiConversation.imageUrl(props.sessionId, ref)}
        openPreview={() => ctx.sidebarRight.openResourceIn(props.sessionId, `dsh-resource://hivemind-artifact/${props.node.id}`, { params: { artifact: props.node.data } })}
      />
    )),
    ctx.slots.register({ name: 'conversation.chat.node', key: 'hivemind-media-workflow', locale: NS }, MediaWorkflowPanel),
  ])
}
