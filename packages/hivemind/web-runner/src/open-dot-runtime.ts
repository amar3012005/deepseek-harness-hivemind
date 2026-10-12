/** Authenticated Core dispatch for canonical Open Dot Runtime employees. */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { employeeExternalDispatchAllowed, projectHyperagentProfiles } from '@deepseek-ai/dsh-hivemind-employee-directory'
import { openExternalEmployeeRoom, roomMessageId, stableRoomDispatchId } from '@deepseek-ai/dsh-api-session-controller'
import type { ExternalEmployeeOperation, ExternalEmployeeRoom, ExternalEmployeeRoomProvider, ExternalRuntimeDispatchStatus } from '@deepseek-ai/dsh-api-session-controller'
import type { AuthenticatedActor, HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { OpenDotRuntimeOperationInput, OpenDotRuntimeOperationService } from './open-dot-runtime-operation.ts'
import { recordExternalEmployeeBlocker } from '@deepseek-ai/dsh-hivemind-hq-runtime'

interface DispatchReceipt {
  version: 1
  dispatchMessageId: string
  nativePacketId: string
  digest: string
  organizationId: string
  userId: string
  employeeId: string
  dotId: string
  rootSessionId: string
  taskId?: string
  taskRevision?: number
  artifactIds: string[]
  receiptId: string
  deliveryState: 'accepted' | 'recorded'
  actor: AuthenticatedActor
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function profileDot(profile: Record<string, unknown>): string {
  const rules = profile['policy_rules'] ?? profile['policyRules']
  const marker = isRecord(rules) ? (rules['open_dot_employee'] ?? rules['openDotEmployee']) : undefined
  const dotId = isRecord(marker) ? (marker['dot_id'] ?? marker['dotId']) : undefined
  if (typeof dotId !== 'string' || !dotId || !employeeExternalDispatchAllowed(profile as Record<string, JsonValue>)) {
    throw new Error('open_dot_employee_not_bound')
  }
  return dotId
}
function serviceToken(principal: HivemindPrincipal, secret: string, rootSessionId?: string): string {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = {
    iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy',
    sub: principal.userId, org_id: principal.orgId, profile: 'hivemind-chat', variation: principal.variation,
    ...(principal.projectId === undefined ? {} : { project_id: principal.projectId }),
    ...(rootSessionId === undefined ? {} : { operating_role: 'runtime', operating_session: rootSessionId }),
    iat: now, exp: now + 30, jti: randomUUID(),
  }
  const input = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode(claims)
  return input + '.' + createHmac('sha256', secret).update(input).digest('base64url')
}

function requireCurrentDispatchTask(ctx: Context, room: ExternalEmployeeRoom, receipt: DispatchReceipt): void {
  if (receipt.taskId === undefined) return
  if (receipt.taskRevision === undefined) throw new Error('open_dot_runtime_task_revision_required')
  const root = ctx.agents.get(SessionId(receipt.rootSessionId))
  if (!root || root.session.header.parentSession !== undefined) throw new Error('open_dot_runtime_root_unavailable')
  const assignment = root.session.snapshotEvents().findLast(event => event.type === 'hivemind/hq-employee-assignment'
    && (event.data as { taskId?: string }).taskId === receipt.taskId)?.data as { employeeId?: string; sessionId?: string } | undefined
  if (assignment?.employeeId !== receipt.employeeId || assignment.sessionId !== room.id) throw new Error('open_dot_runtime_assignment_changed')
  const task = ctx.agentTeams.getTask(root, TeamTaskId(receipt.taskId))
  if (task.revision !== receipt.taskRevision || ['completed', 'deleted'].includes(task.status)) {
    throw new Error('open_dot_runtime_task_changed')
  }
}

/** Accept only callbacks tied to a saved dispatch, then return them through native Runtime room admission. */
export function createOpenDotRuntimeOperationService(ctx: Context, base: URL, secret: string): OpenDotRuntimeOperationService {
  return {
    async execute(input: OpenDotRuntimeOperationInput, signal: AbortSignal) {
      const principal: HivemindPrincipal = { orgId: input.principal.organizationId, userId: input.principal.userId,
        profile: 'hivemind-chat', variation: 'harness' }
      return ctx.hivemindExecutionScope.run(principal, async () => {
        const profile = await loadCanonicalOpenDotProfile(ctx, base, secret, input.employeeId, signal)
        const dotId = profileDot(profile)
        if (dotId !== input.dotId) throw new Error('open_dot_runtime_binding_changed')
        const room = await openExternalEmployeeRoom(ctx, { organizationId: principal.orgId, userId: principal.userId,
          employeeId: input.employeeId, dotId, name: String(profile['name']), role: String(profile['role_archetype'] ?? 'HIVE-MIND employee') })
        if (input.operation === 'blocker') {
          const args = input.approvedargs
          if (!('blocker_key' in args)) throw new Error('open_dot_runtime_blocker_args_invalid')
          const blockerDispatch = room.session.snapshotEvents().findLast(event => event.type === 'hivemind/open-dot-runtime-dispatch-receipt'
            && event.data.dispatchMessageId === input.dispatchMessageId)
          if (blockerDispatch?.type !== 'hivemind/open-dot-runtime-dispatch-receipt') throw new Error('open_dot_runtime_dispatch_receipt_required')
          requireCurrentDispatchTask(ctx, room, blockerDispatch.data as DispatchReceipt)
          const reported = await recordExternalEmployeeBlocker(ctx, room, { dispatchMessageId: input.dispatchMessageId,
            blockerKey: args.blocker_key, question: args.question, ...(args.summary === undefined ? {} : { summary: args.summary }) }, signal)
          return { accepted: true as const, receipt_id: reported.blockerId, delivery_state: 'blocked_reported' }
        }
        const args = input.approvedargs
        if (!('message_key' in args) || args.recipient !== 'runtime') throw new Error('open_dot_runtime_recipient_invalid')
        const dispatch = room.session.snapshotEvents().findLast(event => event.type === 'hivemind/open-dot-runtime-dispatch-receipt'
          && (event.data as DispatchReceipt).dispatchMessageId === input.dispatchMessageId)
        if (dispatch?.type !== 'hivemind/open-dot-runtime-dispatch-receipt') throw new Error('open_dot_runtime_dispatch_receipt_required')
        const savedDispatch = dispatch.data as DispatchReceipt
        requireCurrentDispatchTask(ctx, room, savedDispatch)
        const operationMessageId = roomMessageId(room.id, args.message_key)
        const intentDigest = createHash('sha256').update(JSON.stringify({
          dispatchMessageId: input.dispatchMessageId, messageKey: args.message_key, kind: args.kind,
          text: args.text, summary: args.summary ?? null, replyTo: args.reply_to ?? null, artifactIds: [...args.artifact_ids],
        })).digest('hex')
        const priorIntent = room.session.snapshotEvents().findLast(event => event.type === 'hivemind/open-dot-runtime-operation-intent'
          && event.data.messageId === operationMessageId)
        if (priorIntent?.type === 'hivemind/open-dot-runtime-operation-intent') {
          if (priorIntent.data.digest !== intentDigest || priorIntent.data.dispatchMessageId !== input.dispatchMessageId) {
            throw new Error('open_dot_runtime_operation_idempotency_conflict')
          }
        } else {
          room.session.append('hivemind/open-dot-runtime-operation-intent', { messageId: operationMessageId, digest: intentDigest,
            dispatchMessageId: input.dispatchMessageId, rootSessionId: savedDispatch.rootSessionId, artifactIds: [...args.artifact_ids] })
          if (!await ctx.sessions.flush(room.session)) throw new Error('open_dot_runtime_operation_intent_persistence_required')
        }
        if (args.reply_to !== undefined && args.reply_to !== savedDispatch.nativePacketId) throw new Error('open_dot_runtime_reply_reference_invalid')
        const imported = []
        if (args.artifact_ids.length) {
          if (args.artifact_ids.length > 8 || new Set(args.artifact_ids).size !== args.artifact_ids.length
            || args.artifact_ids.some(id => typeof id !== 'string' || !id || id.length > 180)) throw new Error('open_dot_runtime_artifact_not_owned')
          let aggregate = 0
          for (const sourceId of args.artifact_ids) {
            const response = await fetch(new URL('/internal/v1/harness-chat/core/open-dot/runtime/artifact', base), {
              method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json',
                authorization: 'Bearer ' + serviceToken(principal, secret, savedDispatch.rootSessionId) },
              body: JSON.stringify({ employee_id: input.employeeId, dot_id: input.dotId,
                dispatch_message_id: input.dispatchMessageId, artifact_id: sourceId, root_session_id: savedDispatch.rootSessionId }),
              redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
            const artifact = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
            if (!response.ok || !isRecord(artifact) || artifact['id'] !== sourceId || typeof artifact['name'] !== 'string'
              || typeof artifact['mime'] !== 'string' || !artifact['mime'] || artifact['mime'].length > 128
              || typeof artifact['size'] !== 'number' || !Number.isSafeInteger(artifact['size']) || artifact['size'] < 0 || artifact['size'] > 10 * 1024 * 1024
              || typeof artifact['checksum'] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(artifact['checksum'])
              || typeof artifact['dataBase64'] !== 'string' || artifact['dataBase64'].length > Math.ceil(10 * 1024 * 1024 / 3) * 4) throw new Error('open_dot_runtime_artifact_unverified')
            const bytes = Buffer.from(artifact['dataBase64'], 'base64')
            if (bytes.toString('base64') !== artifact['dataBase64'] || bytes.byteLength !== artifact['size']) throw new Error('open_dot_runtime_artifact_size_invalid')
            aggregate += bytes.byteLength
            if (aggregate > 10 * 1024 * 1024) throw new Error('open_dot_runtime_artifact_limit_exceeded')
            const sha256 = createHash('sha256').update(bytes).digest('hex')
            if (artifact['checksum'] !== 'sha256:' + sha256) throw new Error('open_dot_runtime_artifact_checksum_invalid')
            const file = await ctx.attachments.saveFile({ data: bytes, name: artifact['name'] })
            const artifactId = 'open-dot:' + input.dispatchMessageId + ':' + sourceId
            room.session.append('hivemind/external-artifact-created', { artifactId, title: artifact['name'], mediaType: artifact['mime'],
              provider: 'open-dot-owned', path: null, file, sha256, size: bytes.byteLength, dotId: input.dotId,
              dispatchMessageId: input.dispatchMessageId })
            imported.push({ artifactId, title: artifact['name'], mediaType: artifact['mime'], file,
              producerSessionId: room.id, producerName: room.name })
          }
          if (!await ctx.sessions.flush(room.session)) throw new Error('open_dot_runtime_artifact_receipt_persistence_required')
        }
        const admitted = await ctx.sessionController.receiveExternalEmployeeMessage(room, {
          dispatchMessageId: input.dispatchMessageId, messageKey: args.message_key, kind: args.kind, text: args.text,
          ...(args.summary === undefined ? {} : { summary: args.summary }), ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }),
          ...(imported.length ? { artifacts: imported } : {}),
        }, signal)
        return { accepted: true as const, receipt_id: admitted.messageId, delivery_state: args.kind === 'update' ? 'recorded' : 'accepted' }
      })
    },
  }
}

async function loadCanonicalOpenDotProfile(ctx: Context, base: URL, secret: string, employeeId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const principal = ctx.hivemindExecutionScope.require()
  const response = await fetch(new URL('/internal/v1/harness-chat/core/v1/hyperagents/profiles', base), {
    headers: { accept: 'application/json', authorization: 'Bearer ' + serviceToken(principal, secret) },
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
  if (!response.ok) throw new Error('open_dot_employee_directory_unavailable')
  const directory = projectHyperagentProfiles(await response.json())
  const profile = (directory.profiles as Record<string, unknown>[]).find(row => row['id'] === employeeId)
  if (!profile) throw new Error('open_dot_employee_not_visible')
  profileDot(profile)
  return profile
}

async function pollDispatchStatus(
  ctx: Context, base: URL, secret: string, principal: HivemindPrincipal, room: ExternalEmployeeRoom,
  receipt: DispatchReceipt, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<ExternalRuntimeDispatchStatus> {
  const response = await fetchImpl(new URL('/internal/v1/harness-chat/core/open-dot/runtime/status', base), {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json',
      authorization: 'Bearer ' + serviceToken(principal, secret, receipt.rootSessionId) },
    body: JSON.stringify({ employee_id: receipt.employeeId, dot_id: receipt.dotId,
      message_id: receipt.dispatchMessageId, root_session_id: receipt.rootSessionId }),
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  const value = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
  if (!response.ok || !isRecord(value) || value['accepted'] !== true || value['employeeId'] !== receipt.employeeId
    || value['dotId'] !== receipt.dotId || value['rootSessionId'] !== receipt.rootSessionId
    || value['messageId'] !== receipt.dispatchMessageId
    || (receipt.taskId === undefined ? value['taskId'] !== undefined && value['taskId'] !== null : value['taskId'] !== receipt.taskId)
    || (receipt.taskRevision === undefined ? value['taskRevision'] !== undefined && value['taskRevision'] !== null : value['taskRevision'] !== receipt.taskRevision)
    || typeof value['kind'] !== 'string' || (value['kind'] !== 'question' && value['kind'] !== 'update')
    || typeof value['conversationId'] !== 'string' || !value['conversationId']
    || typeof value['jobId'] !== 'string' || !value['jobId']
    || typeof value['state'] !== 'string'
    || value['state'].length > 80 || !Array.isArray(value['outputs']) || value['outputs'].length > 12
    || !Array.isArray(value['attachments']) || value['attachments'].length > 8) throw new Error('open_dot_runtime_status_unverified')
  const jobResultValue = value['jobResult']
  let jobResult: ExternalRuntimeDispatchStatus['jobResult'] = null
  if (jobResultValue !== null && jobResultValue !== undefined) {
    if (!isRecord(jobResultValue)) throw new Error('open_dot_runtime_status_unverified')
    const allowed = ['outcome', 'reason', 'phase', 'executionStarted', 'messageId', 'accepted']
    if (Object.keys(jobResultValue).some(key => !allowed.includes(key))) throw new Error('open_dot_runtime_status_unverified')
    const picked: { outcome?: string; reason?: string; phase?: string; executionStarted?: boolean; messageId?: string; accepted?: boolean } = {}
    for (const key of ['outcome', 'reason', 'phase', 'messageId'] as const) {
      const part = jobResultValue[key]
      if (part !== undefined) {
        if (typeof part !== 'string' || part.length > 500) throw new Error('open_dot_runtime_status_unverified')
        picked[key] = part
      }
    }
    for (const key of ['executionStarted', 'accepted'] as const) {
      const part = jobResultValue[key]
      if (part !== undefined) {
        if (typeof part !== 'boolean') throw new Error('open_dot_runtime_status_unverified')
        picked[key] = part
      }
    }
    jobResult = picked
  }
  const outputs = value['outputs'].map(item => {
    if (!isRecord(item) || typeof item['messageId'] !== 'string' || !item['messageId'] || item['messageId'].length > 180
      || typeof item['role'] !== 'string' || item['role'].length > 40 || typeof item['text'] !== 'string' || item['text'].length > 2000
      || typeof item['createdAt'] !== 'string' || item['createdAt'].length > 80) throw new Error('open_dot_runtime_status_unverified')
    return { messageId: item['messageId'], role: item['role'], text: item['text'], createdAt: item['createdAt'] }
  })
  const attachments = value['attachments'].map(item => {
    if (!isRecord(item) || typeof item['id'] !== 'string' || !item['id'] || item['id'].length > 180
      || typeof item['name'] !== 'string' || item['name'].length > 240 || typeof item['mime'] !== 'string' || item['mime'].length > 128
      || typeof item['size'] !== 'number' || !Number.isSafeInteger(item['size']) || item['size'] < 0 || item['size'] > 10 * 1024 * 1024) {
      throw new Error('open_dot_runtime_status_unverified')
    }
    return { id: item['id'], name: item['name'], mime: item['mime'], size: item['size'] }
  })
  const result: ExternalRuntimeDispatchStatus = { state: value['state'], jobResult, outputs, attachments }
  const previous = room.session.snapshotEvents().findLast(event => event.type === 'hivemind/open-dot-runtime-status-observed'
    && event.data.dispatchMessageId === receipt.dispatchMessageId)
  const comparable = JSON.stringify({ state: result.state, jobResult: result.jobResult, outputs: result.outputs, attachments: result.attachments })
  const priorComparable = previous?.type === 'hivemind/open-dot-runtime-status-observed'
    ? JSON.stringify({ state: previous.data.state, jobResult: previous.data.jobResult, outputs: previous.data.outputs, attachments: previous.data.attachments }) : undefined
  if (comparable !== priorComparable) {
    room.session.append('hivemind/open-dot-runtime-status-observed', { dispatchMessageId: receipt.dispatchMessageId,
      rootSessionId: receipt.rootSessionId, observedAt: new Date().toISOString(), ...result, outputs: [...result.outputs], attachments: [...result.attachments] })
    if (!await ctx.sessions.flush(room.session)) throw new Error('open_dot_runtime_status_persistence_required')
  }
  await reconcileTerminalRuntimeResult(ctx, base, secret, principal, room, receipt, result, signal, fetchImpl)
  return result
}

const terminalRuntimeStates = new Set(['completed', 'failed', 'killed'])

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { 'open-dot-runtime': 'open-dot-runtime' }
}

const runtimeMonitors = new WeakMap<Context, Map<string, string>>()
function monitorKey(rootSessionId: string, dispatchMessageId: string): string { return `${rootSessionId}:${dispatchMessageId}` }
function delay(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Poll a persisted dispatch with one native background job; retry after process restart from its room receipt. */
export function startOpenDotRuntimeMonitor(
  ctx: Context, base: URL, secret: string, principal: HivemindPrincipal,
  room: ExternalEmployeeRoom,
  receipt: DispatchReceipt, root: Agent, fetchImpl: typeof fetch = fetch,
): string | undefined {
  const key = monitorKey(receipt.rootSessionId, receipt.dispatchMessageId)
  const monitors = runtimeMonitors.get(ctx) ?? new Map<string, string>()
  runtimeMonitors.set(ctx, monitors)
  if (monitors.has(key)) return monitors.get(key) === 'starting' ? undefined : monitors.get(key)
  if (room.session.snapshotEvents().some(event => event.type === 'hivemind/open-dot-runtime-terminal-receipt'
    && event.data.dispatchMessageId === receipt.dispatchMessageId)) return undefined
  monitors.set(key, 'starting')
  let controller: AbortController | undefined
  let jobId: string | undefined
  try {
    jobId = String(ctx.jobs.start({ kind: 'open-dot-runtime', label: `Open Dot result ${receipt.employeeId}`, owner: root,
      outputLimitBytes: 1024, run: () => {
        controller = new AbortController()
        const done = (async () => {
          const deadline = Date.now() + 7 * 24 * 60 * 60 * 1000
          let attempt = 0
          while (!controller!.signal.aborted && Date.now() < deadline) {
            try {
              const status = await ctx.hivemindExecutionScope.run(principal,
                () => pollDispatchStatus(ctx, base, secret, principal, room, receipt, controller!.signal, fetchImpl))
              if (terminalRuntimeStates.has(status.state)) {
                await ctx.hivemindExecutionScope.run(principal, () => reconcileTerminalRuntimeResult(
                  ctx, base, secret, principal, room, receipt, status, controller!.signal, fetchImpl))
                return { status: 'completed' as const, detail: `Runtime review received for ${receipt.dispatchMessageId}` }
              }
            } catch (error) {
              if (controller!.signal.aborted) break
              ctx.logger.warn(`Open Dot result monitor retry for ${receipt.dispatchMessageId}: ${String(error).slice(0, 200)}`)
            }
            attempt += 1
            try { await delay(controller!.signal, attempt < 2 ? 10_000 : attempt < 4 ? 30_000 : 60_000) } catch { break }
          }
          return { status: 'killed' as const, detail: 'Open Dot result monitor stopped or expired; persisted dispatch receipt remains recoverable.' }
        })().finally(() => { if (monitors.get(key) === jobId || monitors.get(key) === 'starting') monitors.delete(key) })
        return { cancel: (reason?: string) => controller?.abort(reason), done }
      } }))
    monitors.set(key, jobId)
    return jobId
  } catch (error) {
    monitors.delete(key)
    ctx.logger.warn(`Open Dot result monitor could not start for ${receipt.dispatchMessageId}: ${String(error).slice(0, 200)}`)
    return undefined
  }
}

/** Reattach persisted pending receipts when their Runtime root is resumed after restart. */
export function installOpenDotRuntimeMonitorRecovery(ctx: Context, base: URL, secret: string): void {
  ctx.effect(() => ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined || !['hivemind-hq','hivemind-hyperagents'].includes(agent.session.header.agentPreset ?? '')) return
    const owner = agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/session-owner')?.data as { slug?: string } | undefined
    if (owner?.slug !== 'runtime') return
    try {
      const snapshots = await ctx.sessionPersistence.list()
      for (const snapshot of snapshots) {
        const id = String(snapshot.header.id)
        if (!id.startsWith('session-open-dot-')) continue
        const reader = await ctx.sessionPersistence.open(snapshot.header.id, 'read')
        let events: readonly SessionEvent[]
        try { events = (await reader.read()).events } finally { await reader.close() }
        const bindingEvent = events.find(event => event.type === 'hivemind/external-employee-room')
        if (!bindingEvent) continue
        const binding = bindingEvent.data as { employeeId?: string; dotId?: string; organizationId?: string; userId?: string }
        if (!binding.employeeId || !binding.dotId || !binding.organizationId || !binding.userId) continue
        const receipts = events.filter(event => event.type === 'hivemind/open-dot-runtime-dispatch-receipt')
        for (const event of receipts) {
          const receipt = event.data as DispatchReceipt
          if (receipt.rootSessionId !== String(agent.id)) continue
          if (events.some(candidate => candidate.type === 'hivemind/open-dot-runtime-terminal-receipt'
            && candidate.data.dispatchMessageId === receipt.dispatchMessageId)) continue
          const room = await openExternalEmployeeRoom(ctx, { organizationId: binding.organizationId, userId: binding.userId,
            employeeId: binding.employeeId, dotId: binding.dotId, name: binding.employeeId, role: 'HIVE-MIND employee' })
          const principal: HivemindPrincipal = { orgId: binding.organizationId, userId: binding.userId,
            profile: 'hivemind-chat', variation: 'harness' }
          startOpenDotRuntimeMonitor(ctx, base, secret, principal, room, receipt, agent)
        }
      }
    } catch (error) {
      ctx.logger.warn(`Open Dot result monitor recovery deferred for ${String(agent.id)}: ${String(error).slice(0, 200)}`)
    }
  }), 'Open Dot Runtime result monitor recovery')
}


export async function reconcileTerminalRuntimeResult(
  ctx: Context, base: URL, secret: string, principal: HivemindPrincipal,
  room: ExternalEmployeeRoom,
  receipt: DispatchReceipt, result: ExternalRuntimeDispatchStatus, signal: AbortSignal, fetchImpl: typeof fetch,
): Promise<void> {
  if (!terminalRuntimeStates.has(result.state)) return
  const priorReceipt = room.session.snapshotEvents().findLast(event => event.type === 'hivemind/open-dot-runtime-terminal-receipt'
    && event.data.dispatchMessageId === receipt.dispatchMessageId)
  if (priorReceipt?.type === 'hivemind/open-dot-runtime-terminal-receipt') {
    if (priorReceipt.data.rootSessionId !== receipt.rootSessionId) throw new Error('open_dot_runtime_terminal_receipt_conflict')
    return
  }
  requireCurrentDispatchTask(ctx, room, receipt)
  if (result.attachments.reduce((sum, item) => sum + item.size, 0) > 10 * 1024 * 1024) {
    throw new Error('open_dot_runtime_terminal_artifact_limit_exceeded')
  }
  const key = `runtime-result-${receipt.dispatchMessageId}`
  const artifacts: NonNullable<ExternalEmployeeOperation['artifacts']> = []
  for (const item of result.attachments) {
    const artifactId = `open-dot:${receipt.dispatchMessageId}:${item.id}`
    const previous = room.session.snapshotEvents().findLast(event => event.type === 'hivemind/external-artifact-created'
      && event.data.artifactId === artifactId)
    if (previous?.type === 'hivemind/external-artifact-created') {
      if (previous.data.title !== item.name || previous.data.mediaType !== item.mime || previous.data.size !== item.size) {
        throw new Error('open_dot_runtime_terminal_artifact_conflict')
      }
      artifacts.push({ artifactId, title: item.name, mediaType: item.mime, file: previous.data.file,
        producerSessionId: room.id, producerName: room.name })
      continue
    }
    const response = await fetchImpl(new URL('/internal/v1/harness-chat/core/open-dot/runtime/artifact', base), {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json',
        authorization: 'Bearer ' + serviceToken(principal, secret, receipt.rootSessionId) },
      body: JSON.stringify({ employee_id: receipt.employeeId, dot_id: receipt.dotId,
        dispatch_message_id: receipt.dispatchMessageId, artifact_id: item.id, root_session_id: receipt.rootSessionId }),
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
    const artifact = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
    if (!response.ok || !isRecord(artifact) || artifact['id'] !== item.id || artifact['name'] !== item.name
      || artifact['mime'] !== item.mime || artifact['size'] !== item.size || typeof artifact['checksum'] !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(artifact['checksum']) || typeof artifact['dataBase64'] !== 'string'
      || artifact['dataBase64'].length > Math.ceil(10 * 1024 * 1024 / 3) * 4) {
      throw new Error('open_dot_runtime_terminal_artifact_unverified')
    }
    const bytes = Buffer.from(artifact['dataBase64'], 'base64')
    if (bytes.toString('base64') !== artifact['dataBase64'] || bytes.byteLength !== item.size) {
      throw new Error('open_dot_runtime_terminal_artifact_size_invalid')
    }
    const checksum = createHash('sha256').update(bytes).digest('hex')
    if (artifact['checksum'] !== 'sha256:' + checksum) throw new Error('open_dot_runtime_terminal_artifact_checksum_invalid')
    const file = await ctx.attachments.saveFile({ data: bytes, name: item.name })
    room.session.append('hivemind/external-artifact-created', { artifactId, title: item.name, mediaType: item.mime,
      provider: 'open-dot-owned', path: null, file, sha256: checksum, size: bytes.byteLength,
      dotId: receipt.dotId, dispatchMessageId: receipt.dispatchMessageId })
    if (!await ctx.sessions.flush(room.session)) throw new Error('open_dot_runtime_terminal_artifact_persistence_required')
    artifacts.push({ artifactId, title: item.name, mediaType: item.mime, file,
      producerSessionId: room.id, producerName: room.name })
  }
  const output = result.outputs.map(item => `[${item.role}] ${item.text}`).join('\n\n').slice(0, 9000)
  const taskIdentity = receipt.taskId === undefined ? 'No HQ task id was saved.' :
    `Saved Runtime task ${receipt.taskId} revision ${receipt.taskRevision ?? 'unknown'}.`
  const text = [
    `Open Dot execution reached terminal state: ${result.state}.`,
    taskIdentity,
    result.state === 'completed'
      ? 'This is a result submission for Runtime review. Inspect the actual saved output and attached files, then record acceptance or specific corrections through the existing HQ task review. Do not mark this complete based on delivery alone.'
      : 'This execution did not complete successfully. Inspect the saved output and task state before deciding whether to resume or revise the assignment.',
    output ? `Saved execution output:\n${output}` : 'No text output was saved.',
    artifacts.length ? `Saved artifact references: ${artifacts.map(item => item.artifactId).join(', ')}.` : 'No output artifacts were saved.',
    `Dispatch receipt: ${receipt.dispatchMessageId}.`,
  ].join('\n\n')
  const artifactIds = artifacts.map(item => item.artifactId)
  const digest = createHash('sha256').update(JSON.stringify({
    dispatchMessageId: receipt.dispatchMessageId, rootSessionId: receipt.rootSessionId,
    taskId: receipt.taskId ?? null, taskRevision: receipt.taskRevision ?? null,
    state: result.state, jobResult: result.jobResult, outputs: result.outputs,
    artifactIds,
  })).digest('hex')
  const priorOutbox = room.session.snapshotEvents().findLast(event => event.type === 'hivemind/open-dot-runtime-terminal-outbox'
    && event.data.dispatchMessageId === receipt.dispatchMessageId)
  if (priorOutbox?.type === 'hivemind/open-dot-runtime-terminal-outbox') {
    if (priorOutbox.data.digest !== digest || priorOutbox.data.messageKey !== key) {
      throw new Error('open_dot_runtime_terminal_idempotency_conflict')
    }
  } else {
    room.session.append('hivemind/open-dot-runtime-terminal-outbox', {
      dispatchMessageId: receipt.dispatchMessageId, rootSessionId: receipt.rootSessionId,
      ...(receipt.taskId !== undefined ? { taskId: receipt.taskId } : {}),
      ...(receipt.taskRevision !== undefined ? { taskRevision: receipt.taskRevision } : {}),
      messageKey: key, digest, text, artifactIds, state: result.state,
    })
    if (!await ctx.sessions.flush(room.session)) throw new Error('open_dot_runtime_terminal_outbox_persistence_required')
  }
  const admitted = await ctx.sessionController.receiveExternalEmployeeMessage(room, {
    dispatchMessageId: receipt.dispatchMessageId, messageKey: key, kind: 'question',
    text, summary: `Open Dot result ${result.state}; Runtime review required.`,
    ...(artifacts.length ? { artifacts } : {}),
  }, signal)
  room.session.append('hivemind/open-dot-runtime-terminal-receipt', {
    dispatchMessageId: receipt.dispatchMessageId, rootSessionId: String(admitted.rootSessionId),
    messageId: admitted.messageId, digest, state: result.state,
  })
  if (!await ctx.sessions.flush(room.session)) throw new Error('open_dot_runtime_terminal_receipt_persistence_required')
}

/** Resolve authenticated current profiles and install the native persistent-room provider. */
export function createOpenDotRoomProvider(ctx: Context, base: URL, secret: string, fetchImpl: typeof fetch = fetch): ExternalEmployeeRoomProvider {
  const currentPrincipal = (): HivemindPrincipal => ctx.hivemindExecutionScope.require()
  const loadProfile = async (principal: HivemindPrincipal, employeeId: string, signal: AbortSignal) => {
    const response = await fetchImpl(new URL('/internal/v1/harness-chat/core/v1/hyperagents/profiles', base), {
      headers: { accept: 'application/json', authorization: 'Bearer ' + serviceToken(principal, secret) },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
    if (!response.ok) throw new Error('open_dot_employee_directory_unavailable')
    const directory = projectHyperagentProfiles(await response.json())
    const profile = (directory.profiles as Record<string, unknown>[]).find(row => row['id'] === employeeId)
    if (!profile) throw new Error('open_dot_employee_not_visible')
    profileDot(profile)
    return profile
  }
  return {
    async resolve(employeeId, roomProfile, signal) {
      if (roomProfile?.executionBackend !== 'open-dot') return undefined
      if (roomProfile.id !== employeeId) throw new Error('open_dot_employee_identity_conflict')
      const principal = currentPrincipal()
      const profile = await loadProfile(principal, employeeId, signal)
      const dotId = profileDot(profile)
      if (roomProfile.dotId !== dotId) throw new Error('open_dot_employee_binding_changed')
      const room = await openExternalEmployeeRoom(ctx, {
        organizationId: principal.orgId, userId: principal.userId, employeeId, dotId,
        name: String(profile['name']), role: String(profile['role_archetype'] ?? 'HIVE-MIND employee'),
      })
      return { room, driverless: true }
    },
    async status({ employeeId, room, dispatchMessageId }, signal) {
      const principal = currentPrincipal()
      if (employeeId !== room.employeeId || room.organizationId !== principal.orgId || room.userId !== principal.userId) {
        throw new Error('open_dot_runtime_binding_changed')
      }
      const profile = await loadProfile(principal, employeeId, signal)
      if (profileDot(profile) !== room.dotId) throw new Error('open_dot_runtime_binding_changed')
      const receipt = room.session.snapshotEvents().findLast(event => event.type === 'hivemind/open-dot-runtime-dispatch-receipt'
        && event.data.dispatchMessageId === dispatchMessageId)
      if (receipt?.type !== 'hivemind/open-dot-runtime-dispatch-receipt' || receipt.data.employeeId !== employeeId
        || receipt.data.dotId !== room.dotId || receipt.data.rootSessionId.length === 0) throw new Error('open_dot_runtime_dispatch_receipt_required')
      return pollDispatchStatus(ctx, base, secret, principal, room, receipt.data as DispatchReceipt, signal, fetchImpl)
    },
    async deliver({ employeeId, room, message, idempotencyKey, authenticatedActor }, signal) {
      const principal = currentPrincipal()
      if (!authenticatedActor || authenticatedActor.userId !== principal.userId || authenticatedActor.orgId !== principal.orgId) {
        throw new Error('open_dot_runtime_actor_required')
      }
      const profile = await loadProfile(principal, employeeId, signal)
      const dotId = profileDot(profile)
      if (dotId !== room.dotId || room.employeeId !== employeeId
        || room.organizationId !== principal.orgId || room.userId !== principal.userId) {
        throw new Error('open_dot_runtime_binding_changed')
      }
      if (message.targetId !== room.id || message.senderEmployee !== 'runtime' || message.senderId === room.id) {
        throw new Error('open_dot_runtime_message_identity_invalid')
      }
      const runtime = ctx.agents.get(SessionId(String(message.senderId)))
      if (!runtime || runtime.session.header.id !== message.senderId || runtime.session.header.parentSession !== undefined
        || !['hivemind-hq', 'hivemind-hyperagents'].includes(runtime.session.header.agentPreset ?? '')) {
        throw new Error('open_dot_runtime_sender_not_live')
      }
      const owner = runtime.session.snapshotEvents().findLast(event => event.type === 'hivemind/session-owner')?.data as
        { slug?: string } | undefined
      if (owner?.slug !== 'runtime') throw new Error('open_dot_runtime_sender_identity_invalid')

      const dispatchMessageId = stableRoomDispatchId(String(message.senderId), message.id)
      let taskRevision: number | undefined
      if (message.taskId !== undefined) {
        const assignment = runtime.session.snapshotEvents().findLast(event => event.type === 'hivemind/hq-employee-assignment'
          && (event.data as { taskId?: string }).taskId === message.taskId)?.data as
          { employeeId?: string; sessionId?: string } | undefined
        if (assignment?.employeeId !== employeeId || assignment.sessionId !== room.id) {
          throw new Error('open_dot_runtime_assignment_mismatch')
        }
        const task = ctx.agentTeams.getTask(runtime, TeamTaskId(message.taskId))
        if (['completed', 'deleted'].includes(task.status)) throw new Error('open_dot_runtime_task_not_active')
        taskRevision = task.revision
      }
      const body = {
        employee_id: employeeId, message_id: dispatchMessageId, root_session_id: String(runtime.id),
        ...(message.taskId === undefined ? {} : { task_id: message.taskId }),
        ...(taskRevision === undefined ? {} : { task_revision: taskRevision }),
        kind: message.kind === 'question' ? 'question' as const : 'update' as const,
        text: message.text, artifact_ids: [...message.artifactIds],
      }
      const digest = createHash('sha256').update(JSON.stringify({
        organizationId: principal.orgId, userId: principal.userId, dotId, body, nativePacketId: message.id, authenticatedActor,
      })).digest('hex')
      const receipts = room.session.snapshotEvents().filter(event => event.type === 'hivemind/open-dot-runtime-dispatch-receipt')
        .map(event => event.data as DispatchReceipt)
      const prior = receipts.find(receipt => receipt.dispatchMessageId === dispatchMessageId)
      if (prior) {
        if (prior.digest !== digest || prior.nativePacketId !== message.id || prior.rootSessionId !== String(runtime.id)
          || prior.employeeId !== employeeId || prior.dotId !== dotId || prior.organizationId !== principal.orgId
          || prior.userId !== principal.userId) throw new Error('open_dot_runtime_idempotency_conflict')
        return { receiptId: prior.receiptId, status: prior.deliveryState }
      }
      if (!idempotencyKey || idempotencyKey !== message.id) throw new Error('open_dot_runtime_native_packet_key_invalid')

      const response = await fetchImpl(new URL('/internal/v1/harness-chat/core/open-dot/runtime/dispatch', base), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json',
          authorization: 'Bearer ' + serviceToken(principal, secret, String(runtime.id)) },
        body: JSON.stringify(body), redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      })
      const result = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
      if (!response.ok || !isRecord(result) || result['accepted'] !== true
        || typeof result['receipt_id'] !== 'string' || typeof result['delivery_state'] !== 'string') {
        throw new Error('open_dot_runtime_dispatch_unconfirmed')
      }
      const receipt: DispatchReceipt = { version: 1, dispatchMessageId, nativePacketId: message.id, digest,
        organizationId: principal.orgId, userId: principal.userId, employeeId, dotId,
        rootSessionId: String(runtime.id), ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
        ...(taskRevision === undefined ? {} : { taskRevision }), artifactIds: [...message.artifactIds], receiptId: result['receipt_id'],
        deliveryState: result['delivery_state'] === 'recorded' ? 'recorded' : 'accepted', actor: authenticatedActor }
      room.session.append('hivemind/open-dot-runtime-dispatch-receipt', receipt)
      if (!await ctx.sessions.flush(room.session)) throw new Error('open_dot_runtime_receipt_persistence_required')
      startOpenDotRuntimeMonitor(ctx, base, secret, principal, room, receipt, runtime, fetchImpl)
      return { receiptId: receipt.receiptId, status: receipt.deliveryState }
    },
  }
}