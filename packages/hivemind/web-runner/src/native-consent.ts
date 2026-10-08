/** Optional signed native-session binding; absence preserves the existing web contract. */
export function nativeSessionBinding(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('invalid native session binding')
  return value
}
export async function nativePrincipalAllowed(principal: Record<string, string>, check: () => Promise<boolean>): Promise<boolean> {
  try { return nativeSessionBinding(principal.native_session_hash) === undefined || await check() }
  catch { return false }
}
