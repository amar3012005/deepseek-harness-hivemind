/** Local outgoing-call tone; no microphone, provider request, or remote media. */
export function startCallRingback(): () => void {
  if (typeof AudioContext === 'undefined') return () => {}
  let context: AudioContext
  try { context = new AudioContext() } catch { return () => {} }
  let stopped = false
  const gain = context.createGain()
  gain.gain.value = 0
  gain.connect(context.destination)
  const tones = [440, 480].map((frequency) => {
    const tone = context.createOscillator()
    tone.frequency.value = frequency
    tone.connect(gain)
    tone.start()
    return tone
  })
  const pulse = () => {
    if (stopped) return
    const now = context.currentTime
    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.035, now + 0.02)
    gain.gain.setValueAtTime(0.035, now + 0.9)
    gain.gain.linearRampToValueAtTime(0, now + 1)
  }
  pulse()
  void context.resume().catch(() => {})
  const interval = setInterval(pulse, 4000)
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(interval)
    clearTimeout(deadline)
    gain.gain.cancelScheduledValues(context.currentTime)
    gain.gain.value = 0
    for (const tone of tones) { tone.stop(); tone.disconnect() }
    gain.disconnect()
    void context.close().catch(() => {})
  }
  const deadline = setTimeout(stop, 60000)
  return stop
}
