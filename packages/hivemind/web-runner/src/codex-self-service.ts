/** Stable connection ownership, derived only from server-authenticated identity. */
import { createHash } from 'node:crypto'
export function codexConnectionId(actor: { orgId:string;userId:string }): string {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
  if(!uuid.test(actor.orgId)||!uuid.test(actor.userId))throw Error('connection_actor_invalid')
  return `cp-${createHash('sha256').update(`${actor.orgId.toLowerCase()}:${actor.userId.toLowerCase()}`).digest('hex').slice(0,48)}`
}
