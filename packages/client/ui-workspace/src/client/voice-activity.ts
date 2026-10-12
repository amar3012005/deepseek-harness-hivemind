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
export function observeVoiceActivity(input: MediaStream, onLevels: (levels: VoiceLevels) => void, nativePlayback = false) {
  const unavailable = {
    playsThroughWebAudio: false,
    remote: (_stream: MediaStream) => {}, setSpeakerMuted: (_muted: boolean) => {}, stop: () => {},
  }
  let context: AudioContext
  try { context = new AudioContext() } catch { return unavailable }
  let microphone: MediaStreamAudioSourceNode
  let user: AnalyserNode
  let speaker: GainNode | undefined
  try {
    microphone = context.createMediaStreamSource(input)
    user = context.createAnalyser(); user.fftSize = 256
    microphone.connect(user)
    // WKWebView can receive nonzero WebRTC audio while its MediaStream-backed
    // HTMLAudioElement remains inaudible. Native calls use this existing running
    // context for output. Microphone analysis never connects to the speaker.
    if (nativePlayback) { speaker = context.createGain(); speaker.connect(context.destination) }
  } catch {
    void context.close().catch(() => {})
    return unavailable
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
    playsThroughWebAudio: Boolean(speaker),
    setSpeakerMuted(muted: boolean) { if (speaker) speaker.gain.value = muted ? 0 : 1 },
    remote(stream: MediaStream) {
      if (stopped) return
      output?.disconnect(); agent?.disconnect()
      output = undefined; agent = undefined
      try {
        output = context.createMediaStreamSource(stream)
        agent = context.createAnalyser(); agent.fftSize = 256
        output.connect(agent)
        if (speaker) output.connect(speaker)
      } catch { output?.disconnect(); output = undefined; agent = undefined }
    },
    stop() {
      if (stopped) return
      stopped = true; cancelAnimationFrame(frame)
      microphone.disconnect(); user.disconnect(); output?.disconnect(); agent?.disconnect()
      speaker?.disconnect()
      void context.close().catch(() => {})
      onLevels({ user: 0, agent: 0 })
    },
  }
}
