/** Product-branded diagnostics for embedded company sessions; native diagnostics remain intact. */
export function clientError(...values: unknown[]): void {
  const hive = typeof document !== 'undefined' && document.documentElement.dataset.dshMode === 'hivemind-chat'
  const label = (value: string) => value.replaceAll('[cordis-client-runner]', '[HIVEMIND]')
    .replace(/@deepseek-ai\/dsh-[a-z0-9-]+/gu, 'HIVEMIND component')
    .replace(/DeepSeek Harness|deepseek-harness|\bDSH\b/gu, 'HIVEMIND')
  console.error(...(hive ? values.map(value => value instanceof Error ? label(value.message)
    : typeof value === 'string' ? label(value) : value && typeof value === 'object' && 'message' in value
      ? label(String(value.message)) : value) : values))
}
