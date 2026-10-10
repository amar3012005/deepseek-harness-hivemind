/** Read audio already owned by a call. Never acquires or stops a media track. */
export interface VoiceLevels { user: number; agent: number }

/** Quiet-room noise must not animate an otherwise silent call. */
export function voiceLevel(samples: Uint8Array): number {
  let energy = 0
  for (const sample of samples) energy += ((sample - 128) / 128) ** 2
  const rms = Math.sqrt(energy / Math.max(1, samples.length))
  return rms < 0.015 ? 0 : Math.min(1, (rms - 0.015) * 5)
}

/** Tap the existing microphone and replaceable provider output stream. */
export function observeVoiceActivity(input: MediaStream, onLevels: (levels: VoiceLevels) => void) {
  let context: AudioContext
  try { context = new AudioContext() } catch { return { remote: (_stream: MediaStream) => {}, stop: () => {} } }
  let microphone: MediaStreamAudioSourceNode
  let user: AnalyserNode
  try {
    microphone = context.createMediaStreamSource(input)
    user = context.createAnalyser(); user.fftSize = 256
    microphone.connect(user)
  } catch {
    void context.close().catch(() => {})
    return { remote: (_stream: MediaStream) => {}, stop: () => {} }
  }
  let output: MediaStreamAudioSourceNode | undefined
  let agent: AnalyserNode | undefined
  const samples = new Uint8Array(256)
  let stopped = false
  let frame = 0
  let last = 0
  const tick = (now: number) => {
    if (stopped) return
    if (now - last >= 32) {
      last = now
      user.getByteTimeDomainData(samples)
      const localLevel = voiceLevel(samples)
      if (agent) agent.getByteTimeDomainData(samples)
      onLevels({ user: localLevel, agent: agent ? voiceLevel(samples) : 0 })
    }
    frame = requestAnimationFrame(tick)
  }
  void context.resume().catch(() => {})
  frame = requestAnimationFrame(tick)
  return {
    remote(stream: MediaStream) {
      if (stopped) return
      output?.disconnect(); agent?.disconnect()
      output = undefined; agent = undefined
      try {
        output = context.createMediaStreamSource(stream)
        agent = context.createAnalyser(); agent.fftSize = 256
        output.connect(agent)
      } catch { output?.disconnect(); output = undefined; agent = undefined }
    },
    stop() {
      if (stopped) return
      stopped = true; cancelAnimationFrame(frame)
      microphone.disconnect(); user.disconnect(); output?.disconnect(); agent?.disconnect()
      void context.close().catch(() => {})
      onLevels({ user: 0, agent: 0 })
    },
  }
}
