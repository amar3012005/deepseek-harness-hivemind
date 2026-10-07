import type { HivemindPrincipal } from './index.ts'
export interface AuthenticatedActor { readonly userId:string; readonly orgId:string; readonly name:string; readonly role:string }
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
/** Only server-produced user, voice, and native room-message sources carry authority. */
export function authenticatedActorFromSource(value: unknown): AuthenticatedActor | undefined {
  if (!value || typeof value!=='object') return undefined
  const source=value as Record<string,unknown>
  if (source['kind']!=='user' && source['kind']!=='schedule' && source['kind']!=='hivemind-runtime-event' && source['kind']!=='hivemind-agent-message'
    && !(source['kind']==='plugin' && source['plugin']==='hivemind-live-voice')) return undefined
  const actor=source['authenticatedActor'] as AuthenticatedActor | undefined
  if (!actor || !uuid.test(actor.userId) || !uuid.test(actor.orgId) || !['admin','owner'].includes(actor.role)
    || typeof actor.name!=='string' || actor.name.length>180) return undefined
  return Object.freeze({ ...actor })
}
/** Human account selection is independent from organization agent storage. */
export function principalForActor(principal:HivemindPrincipal,actor:AuthenticatedActor | undefined):HivemindPrincipal {
  if (!actor) return principal
  if (actor.orgId!==principal.orgId) throw new Error('authenticated_actor_organization_mismatch')
  return Object.freeze({ ...principal,userId:actor.userId })
}
