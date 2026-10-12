/** Persisted Open Dot proxy room identity; this is not an Agent and has no DSH loop. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
type RoomHandle = Awaited<ReturnType<Context['sessionPersistence']['create']>>
type RoomResource = { session: Session; writer: RoomHandle; detach: () => void }
const resources = new WeakMap<Context, Map<string, RoomResource>>()
const installed = new WeakSet<Context>()

export function installExternalRoomPersistence(ctx: Context): void {
  if (installed.has(ctx)) return
  installed.add(ctx)
  resources.set(ctx, new Map())
  ctx.effect(() => async () => {
    const rooms = resources.get(ctx)
    if (!rooms) return
    resources.delete(ctx)
    for (const resource of rooms.values()) {
      resource.detach()
      await resource.writer.close()
    }
    rooms.clear()
    installed.delete(ctx)
  }, 'session-controller: Open Dot proxy room persistence')
}

type ExternalActor = { readonly userId: string; readonly orgId: string; readonly name: string; readonly role: string }

export interface ExternalEmployeeRoom {
  readonly kind: 'external-persistent-assignee'
  readonly id: SessionId
  readonly session: Session
  readonly status: 'idle'
  readonly employeeId: string
  readonly dotId: string
  readonly organizationId: string
  readonly userId: string
  readonly name: string
  readonly role: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'hivemind/open-dot-runtime-dispatch-receipt': {
      version: 1; dispatchMessageId: string; nativePacketId: string; digest: string
      organizationId: string; userId: string; employeeId: string; dotId: string; rootSessionId: string
      taskId?: string; taskRevision?: number; artifactIds: string[]; receiptId: string; deliveryState: 'accepted' | 'recorded'; actor: ExternalActor
    }
    'hivemind/open-dot-runtime-status-observed': {
      dispatchMessageId: string; rootSessionId: string; observedAt: string
      state: string; jobResult: Record<string, unknown> | null
      outputs: { messageId: string; role: string; text: string; createdAt: string }[]
      attachments: { id: string; name: string; mime: string; size: number }[]
    }
  }
}

interface ExternalRoomBinding {
  readonly employeeId: string
  readonly dotId: string
  readonly organizationId: string
  readonly userId: string
  readonly backend: 'open-dot'
}

function identitySessionId(organizationId: string, userId: string, employeeId: string): SessionId {
  const digest = createHash('sha256').update(JSON.stringify(['hivemind-open-dot-room-v1', organizationId, userId, employeeId])).digest('hex')
  return SessionId(`session-open-dot-${digest.slice(0, 40)}`)
}

function validate(session: Session, binding: ExternalRoomBinding): void {
  if (session.header.id !== session.id || session.header.parentSession !== undefined) throw new Error('external_room_session_identity_invalid')
  const events = session.snapshotEvents()
  const owner = events.find(event => String(event.type) === 'hivemind/session-owner')?.data as { id?: string } | undefined
  const marker = events.find(event => event.type === 'hivemind/external-employee-room')?.data as ExternalRoomBinding | undefined
  if (owner?.id !== binding.employeeId || marker?.employeeId !== binding.employeeId
    || marker.dotId !== binding.dotId || marker.organizationId !== binding.organizationId
    || marker.userId !== binding.userId || marker.backend !== 'open-dot') {
    throw new Error('external_room_binding_conflict')
  }
}

export async function openExternalEmployeeRoom(
  ctx: Context,
  input: { organizationId: string; userId: string; employeeId: string; dotId: string; name: string; role: string },
): Promise<ExternalEmployeeRoom> {
  const binding: ExternalRoomBinding = { ...input, backend: 'open-dot' }
  const id = identitySessionId(input.organizationId, input.userId, input.employeeId)
  const rooms = resources.get(ctx)
  if (!rooms) throw new Error('external_room_persistence_lifecycle_required')
  let resource = rooms.get(String(id))
  let session = resource?.session ?? ctx.sessions.get(id)
  if (session && !resource) throw new Error('external_room_persistence_owner_missing')
  if (!session) {
    let writer: RoomHandle | undefined
    let detach: (() => void) | undefined
    try {
      try {
        writer = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false })
      } catch {
        writer = await ctx.sessionPersistence.open(id, 'write')
      }
      if (writer.access !== 'write') throw new Error('external_room_writer_required')
      const stored = await writer.read()
      session = stored.events.length === 0
        ? Session.create(id, undefined, writer.header)
        : Session.fromRestore(id, stored.events, writer.header, writer.inheritedEventCount, stored.eventState)
      detach = ctx.sessions.enter(session)
      if (stored.events.length === 0) {
        Reflect.apply(session.append, session, ['hivemind/session-owner', { id: input.employeeId, slug: 'open-dot-employee', name: input.name, role: input.role }])
        session.append('hivemind/external-employee-room', binding)
      }
      validate(session, binding)
      resource = { session, writer, detach }
      rooms.set(String(id), resource)
      if (!(await ctx.sessions.flush(session))) throw new Error('external_room_persistence_required')
      ctx.sessions.announce(session)
    } catch (error) {
      rooms.delete(String(id))
      detach?.()
      await writer?.close()
      throw error
    }
  }
  if (resource && session && resource.session !== session) throw new Error('external_room_session_conflict')
  if (!session) throw new Error('external_room_session_unavailable')
  validate(session, binding)
  return { kind: 'external-persistent-assignee', id, session, status: 'idle', ...input }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'hivemind/open-dot-runtime-operation-intent': { messageId: string; digest: string; dispatchMessageId: string; rootSessionId: string; artifactIds: string[] }
  }
}
