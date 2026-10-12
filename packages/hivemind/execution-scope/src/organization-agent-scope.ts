import type { HivemindPrincipal } from './index.ts'
/** Storage scope never escapes into model/connector credential resolution. */
export type AgentStorageScope = HivemindPrincipal & { readonly actorUserId?: string; readonly organizationAgent?: true }
export async function organizationAgentScope(
  client: { query(sql: string, values: unknown[]): Promise<{ rows: { storage_user_id?:string }[] }> },
  principal: AgentStorageScope,
): Promise<AgentStorageScope> {
  const actor = principal.actorUserId ?? principal.userId
  await client.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)", [principal.orgId,actor])
  const proof = await client.query(
    'SELECT storage_user_id FROM organization_agent_storage_scope($1::uuid,$2::uuid)',[principal.orgId,actor])
  const userId = proof.rows[0]?.storage_user_id
  if (!userId) throw new Error('organization_agent_admin_required')
  if (principal.organizationAgent && userId !== principal.userId) throw new Error('organization_agent_storage_scope_changed')
  return Object.freeze({ ...principal,userId,actorUserId:actor,organizationAgent:true })
}
