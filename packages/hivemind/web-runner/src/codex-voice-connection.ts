/** Host-only transport seam; native voice lifecycle never receives an OAuth token. */
import type WebSocket from 'ws'
export interface CodexVoiceConnection {
  start(input: { sdp: string; session: unknown }, signal: AbortSignal): Promise<Response>
  socket(callId: string): WebSocket
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Resolve the authenticated user's selected live-voice connection.
     * @mode serial
     */
    'hivemind/codex-voice-connection'(): Promise<CodexVoiceConnection | undefined>
  }
}
