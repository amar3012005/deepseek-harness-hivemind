import { isLoopbackHostname } from '../loopback-hostname.ts'
/** A packaged client connected to a remote Host never owns local privileges. */
export function transportIsLoopback(
  transport: { ownsHost?: boolean; remoteHost?: boolean } | undefined,
  location: { hostname: string } | undefined,
): boolean {
  if (transport?.remoteHost === true) return false
  return transport?.ownsHost === true || location === undefined || isLoopbackHostname(location.hostname)
}
