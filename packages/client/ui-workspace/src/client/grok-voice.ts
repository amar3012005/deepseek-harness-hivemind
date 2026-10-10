/** Existing Tara browser PCM protocol, scoped by a server-issued one-use capability. */
export async function startGrokVoice(sessionId: string, stream: MediaStream, audio: HTMLAudioElement,
  onReady: () => void, onCaption: (text: string) => void, onClosed: (failed: boolean) => void, onClosing: () => void,
  onAssistantAudio: () => void = () => {}) {
  const response = await fetch('/api/hivemind/voice/fallback/start', { method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(35000) })
  const result = await response.json() as {
    provider?: string
    session_id?: string
    ws_url?: string
    capability?: string
    audio_format?: { sample_rate?: number }
    closing_after_ms?: number
  }
  if (!response.ok || result.provider !== 'grok' || !result.session_id || !result.capability || !result.ws_url?.startsWith('wss://')) throw new Error('fallback_unavailable')
  const rate = result.audio_format?.sample_rate
  if (rate !== 16000 && rate !== 24000) throw new Error('unsupported_voice_format')
  const socket = new WebSocket(`${result.ws_url.replace(/\/$/, '')}/${encodeURIComponent(result.session_id)}`, ['hm.tara.v1', `hm.tara.cap.${result.capability}`])
  socket.binaryType = 'arraybuffer'
  const context = new AudioContext({ sampleRate: rate })
  const output = context.createMediaStreamDestination()
  audio.srcObject = output.stream
  const input = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  let next = context.currentTime
  let closingTimer: ReturnType<typeof setTimeout> | undefined
  let closing = false
  let closed = false
  let failed = false
  const sources = new Set<AudioBufferSourceNode>()
  const clearPlayback = () => {
    for (const source of sources) { try { source.stop() } catch {} }
    sources.clear(); next = context.currentTime
  }
  const handoff = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const saved = await fetch('/api/hivemind/voice/fallback/finish', { method: 'POST', credentials: 'include', keepalive: true,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, callId: result.session_id }) })
      if (saved.ok && saved.status !== 202) return
      if (saved.status !== 202) throw new Error('voice_handoff_failed')
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)))
    }
    throw new Error('voice_handoff_pending')
  }
  const close = () => {
    if (closed) return
    closed = true; if (closingTimer) clearTimeout(closingTimer); clearPlayback(); processor.disconnect(); input.disconnect(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'runtime_end' })); socket.close(1000)
    void context.close()
  }
  socket.onopen = () => {
    void context.resume(); void audio.play().catch(() => { failed = true })
    processor.onaudioprocess = (event) => {
      if (closing || socket.readyState !== WebSocket.OPEN) return
      const samples = event.inputBuffer.getChannelData(0)
      const pcm = new Int16Array(samples.length)
      for (let index = 0; index < samples.length; index++) pcm[index] = Math.max(-1, Math.min(1, samples[index] ?? 0)) * 0x7fff
      socket.send(pcm.buffer)
    }
    input.connect(processor); processor.connect(context.destination)
  }
  socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      const pcm = new Int16Array(event.data)
      if (pcm.length) onAssistantAudio()
      const buffer = context.createBuffer(1, pcm.length, rate)
      const samples = buffer.getChannelData(0)
      for (let index = 0; index < pcm.length; index++) samples[index] = (pcm[index] ?? 0) / 32768
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(output)
      source.onended = () => sources.delete(source); sources.add(source)
      source.start(Math.max(context.currentTime, next)); next = Math.max(context.currentTime, next) + buffer.duration
      return
    }
    let value: { type?: string; text?: string }
    try { value = JSON.parse(String(event.data)) } catch { return }
    if (value.type === 'ready') { onReady(); if (typeof result.closing_after_ms === 'number' && !closingTimer) closingTimer = setTimeout(() => { closing = true; stream.getAudioTracks().forEach((track) => { track.enabled = false }); onClosing() }, result.closing_after_ms) }
    if (value.type === 'speech_start') clearPlayback()
    if (['transcript', 'agent_text'].includes(value.type ?? '') && value.text) onCaption(value.text)
    if (value.type === 'error') failed = true
  }
  socket.onerror = () => { failed = true }
  socket.onclose = (event) => {
    close()
    void handoff().then(() => onClosed(failed || event.code !== 1000), () => onClosed(true))
  }
  return { close, id: result.session_id }
}
