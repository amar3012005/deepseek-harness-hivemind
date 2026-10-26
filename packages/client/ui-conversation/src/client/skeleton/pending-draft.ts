/**
 * Composer text typed before a Session's input machine attaches.
 *
 * The buffer is in-memory, keyed by Session id, and never sent. The composer
 * hands it to the input machine once on attach; send stays disabled until the
 * machine is live, so the buffered text cannot be submitted twice.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const buffers = new Map<SessionId, string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * Read the buffered text for one Session.
 * @param sessionId - Session that owns the buffer.
 * @returns the buffered text, or the empty string when none is held.
 */
export function readPendingDraft(sessionId: SessionId): string {
  return buffers.get(sessionId) ?? ''
}

/**
 * Replace the buffered text for one Session. Empty text clears the buffer.
 * @param sessionId - Session that owns the buffer.
 * @param text - full text currently typed into the pre-attach composer.
 */
export function writePendingDraft(sessionId: SessionId, text: string): void {
  if (text === '') buffers.delete(sessionId)
  else buffers.set(sessionId, text)
  notify()
}

/**
 * Remove and return the buffered text for one Session.
 * @param sessionId - Session that owns the buffer.
 * @returns the text that was buffered, or the empty string.
 */
export function takePendingDraft(sessionId: SessionId): string {
  const text = buffers.get(sessionId) ?? ''
  if (text !== '') {
    buffers.delete(sessionId)
    notify()
  }
  return text
}

/**
 * Subscribe to buffer changes for any Session.
 * @param listener - called after every write or take.
 * @returns disposer removing the listener.
 */
export function subscribePendingDrafts(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Combine the attached machine draft with buffered text without dropping either.
 * @param machineDraft - draft already held by the input machine.
 * @param pendingText - text typed before attach.
 * @returns the draft the machine should hold after handoff.
 */
export function mergeHandoffDraft(machineDraft: string, pendingText: string): string {
  if (pendingText === '') return machineDraft
  if (machineDraft.trim() === '') return pendingText
  return `${machineDraft}\n${pendingText}`
}

/** Window message type posted by the Da-vinci host shell after the frame loads. */
export const HOST_DRAFT_MESSAGE_TYPE = 'hm:composer-draft'

let hostParentOrigins: readonly string[] = []

/**
 * Validate and publish the parent origins allowed to hand over drafts.
 * Each entry must be an exact origin (scheme, host, optional port, no path).
 * @param origins - configured origins from the Conversation plugin config.
 * @throws Error when an entry is not an exact origin; startup fails instead of ignoring it.
 */
export function configureHostDraftParentOrigins(origins: readonly string[]): void {
  for (const origin of origins) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new Error(`ui-conversation: invalid host draft parent origin '${origin}'`)
    }
    if (parsed.origin !== origin) {
      throw new Error(`ui-conversation: host draft parent origin must be an exact origin, got '${origin}'`)
    }
  }
  hostParentOrigins = [...origins]
}

/**
 * Parent origins currently allowed to hand over drafts.
 * @returns the configured origins, empty until configured.
 */
export function hostDraftParentOrigins(): readonly string[] {
  return hostParentOrigins
}

/**
 * Adopt host-provided text into the buffer once. Adoption requires both the
 * buffer and the attached machine draft to be empty, so typed text is never
 * overwritten.
 * @param sessionId - Session that receives the text.
 * @param text - handed-over draft text.
 * @param machineDraft - draft currently held by the input machine (empty before attach).
 * @returns true when the text was adopted.
 */
export function adoptHostDraft(sessionId: SessionId, text: string, machineDraft: string): boolean {
  if (text.trim() === '') return false
  if (readPendingDraft(sessionId) !== '' || machineDraft.trim() !== '') return false
  writePendingDraft(sessionId, text)
  return true
}

/** Minimal message-event surface the host draft listener reads. */
export interface HostDraftMessageSource {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/**
 * Accept a window message from an allowed origin and adopt its draft for this frame's room.
 * @param source - window that receives the message.
 * @param options.selfOrigin - this frame's origin.
 * @param options.allowedParentOrigins - parent origins allowed to hand over drafts.
 * @param options.roomId - host room key (`runtime` or `brain`) this frame shows.
 * @param options.sessionId - Session that receives the text.
 * @param options.machineDraft - returns the draft currently held by the input machine.
 * @returns disposer removing the listener.
 */
export function listenForHostDrafts(
  source: HostDraftMessageSource,
  options: {
    readonly selfOrigin: string
    readonly allowedParentOrigins: readonly string[]
    readonly roomId: string
    readonly sessionId: SessionId
    readonly machineDraft: () => string
  },
): () => void {
  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== options.selfOrigin && !options.allowedParentOrigins.includes(event.origin)) return
    const data: unknown = event.data
    if (typeof data !== 'object' || data === null) return
    const message = data as { type?: unknown; roomId?: unknown; text?: unknown }
    if (message.type !== HOST_DRAFT_MESSAGE_TYPE) return
    if (typeof message.roomId !== 'string' || message.roomId !== options.roomId) return
    if (typeof message.text !== 'string') return
    adoptHostDraft(options.sessionId, message.text, options.machineDraft())
  }
  source.addEventListener('message', onMessage)
  return () => { source.removeEventListener('message', onMessage) }
}

/**
 * Room key the Da-vinci host uses for `roomId`: `runtime` on employee rooms and `brain` on Brain routes.
 * @param pathname - page pathname.
 * @returns the room key, or undefined on routes that take no host draft.
 */
export function hostDraftRoomKey(pathname: string): 'runtime' | 'brain' | undefined {
  if (pathname.startsWith('/hivemind/app/employee/')) return 'runtime'
  if (pathname === '/hivemind/app/brain' || pathname.startsWith('/hivemind/app/brain/')
    || pathname.startsWith('/hivemind/app/overview')) return 'brain'
  return undefined
}
