/** HTTP authority selection for the HIVE-MIND embedded Web runner. */

export interface AuthorityHeaders {
  host?: string | undefined
  'x-forwarded-host'?: string | string[] | undefined
}

/**
 * Resolve the authority used for same-origin checks and Connection cookies.
 *
 * A trusted reverse proxy pins `Host` to the public application authority.
 * `x-forwarded-host` is only a fallback because intermediary proxies may append
 * their own transport hostname to that header.
 *
 * @param headers - Request authority headers received by the runner.
 * @returns The selected authority, or `undefined` when neither header supplies one.
 */
export function publicHost(headers: AuthorityHeaders): string | undefined {
  if (typeof headers.host === 'string' && headers.host.trim()) return headers.host.trim()
  const forwarded = headers['x-forwarded-host']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return typeof value === 'string' && value.trim() ? value.split(',', 1)[0]?.trim() : undefined
}
