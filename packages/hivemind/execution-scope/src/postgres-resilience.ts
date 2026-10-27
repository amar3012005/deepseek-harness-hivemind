/**
 * Boot retry and pool error containment shared by every HIVE Postgres plugin.
 *
 * A Postgres pool emits `error` when an idle client loses its connection, for
 * example when the database tunnel drops. Node ends the process on an `error`
 * event without a listener, so every pool attaches {@link containPoolErrors}.
 * pg-pool discards the failed client and opens a new connection for the next
 * query; requests that were running on the dropped connection reject to their
 * own callers.
 *
 * Each plugin declares `initAttempts` (natural, at least 1, default 1) and
 * `initRetryDelayMs` (natural, default 1000) in its own validated `Config`.
 */
/** Boot retry settings accepted by each Postgres plugin's `Config`. */
export interface PostgresBootRetryConfig {
  /** Reachability probes before boot fails; 1 disables retry. */
  initAttempts?: number
  /** First delay between probes in ms; doubles after each failed attempt. */
  initRetryDelayMs?: number
}

/** Logger surface used for retry and pool warnings. */
export interface PostgresResilienceLogger {
  warn(message: string): void
}

/** Pool or client surface that reports idle connection failures as events. */
export interface PostgresErrorEmitter {
  on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * Run a boot reachability probe, retrying with doubling backoff.
 * @param label - plugin name used in warnings.
 * @param probe - reads that must succeed before the plugin starts.
 * @param config - attempt count and first delay.
 * @param logger - receives one warning per failed attempt that will be retried.
 * @param sleep - delay function; tests replace it.
 * @returns when one probe succeeds.
 * @throws the last probe error once the attempts are spent.
 */
export async function probePostgresAtBoot(
  label: string,
  probe: () => Promise<unknown>,
  config: PostgresBootRetryConfig,
  logger: PostgresResilienceLogger,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<void> {
  const attempts = config.initAttempts ?? 1
  for (let attempt = 1; ; attempt++) {
    try {
      await probe()
      return
    } catch (error) {
      if (attempt >= attempts) throw error
      const delay = (config.initRetryDelayMs ?? 1000) * 2 ** (attempt - 1)
      logger.warn(`${label}: boot probe ${String(attempt)}/${String(attempts)} failed, retrying in ${String(delay)} ms: ${String(error)}`)
      await sleep(delay)
    }
  }
}

/**
 * Keep idle connection failures of a pool from ending the process.
 * @param label - plugin name used in warnings.
 * @param pool - pool whose idle clients may fail.
 * @param logger - receives one warning per failed idle client.
 * @returns the same pool.
 */
export function containPoolErrors<Pool extends PostgresErrorEmitter>(
  label: string,
  pool: Pool,
  logger: PostgresResilienceLogger,
): Pool {
  pool.on('error', (error) => {
    logger.warn(`${label}: idle database connection failed; the pool reconnects on the next query: ${error.message}`)
  })
  return pool
}
