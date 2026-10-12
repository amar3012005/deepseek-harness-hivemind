/** Opt-in actual restricted-role proof in a disposable shared_admin_test database. */
import { SessionCommandController } from '../../../api/session-controller/src/commands.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import { expect,it } from 'vitest'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore,{ SESSION_FORMAT_VERSION,SessionId,SessionSeq } from '@deepseek-ai/dsh-session'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { PostgresSessionPersistence } from '@deepseek-ai/dsh-session-persistence-postgres'
import ScheduleService,{ type ScheduleTask,type ScheduleOwnershipPolicy } from '@deepseek-ai/dsh-schedule'
import ScheduleBackend,{ POSTGRES_SCHEDULE_BACKEND } from '../../../hivemind/schedule-postgres/src/index.ts'
const url=process.env.DSH_SHARED_ADMIN_TEST_DATABASE_URL
it.skipIf(!url)('shares canonical native rooms and schedules with active admins while retaining human authority and Brain privacy',async()=>{
  if(new URL(url!).pathname!=='/shared_admin_test') throw Error('disposable_database_required')
  const bootstrap=new Pool({ connectionString:url })
  await bootstrap.query('DROP SCHEMA IF EXISTS hivemind CASCADE; CREATE SCHEMA hivemind')
  await bootstrap.end()
  const admin=new Pool({ connectionString:url,options:'-c search_path=hivemind,public' })
  const a={ orgId:'67503d34-97e9-49a8-8c52-8ee30cc7603e',userId:'54f5568b-4d6a-4ae1-9a33-48cb2909d59b',profile:'hivemind-chat' as const,variation:'harness' }
  const b={ ...a,userId:'64f5568b-4d6a-4ae1-9a33-48cb2909d59b' }, member={ ...a,userId:'74f5568b-4d6a-4ae1-9a33-48cb2909d59b' }
  const ctx=new Context(); let restricted:Pool|undefined, schedulePool:Pool|undefined
  try {
    await admin.query(`SET search_path=hivemind,public;
      CREATE TABLE organizations(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE user_organizations(user_id uuid,org_id uuid,role text,is_active boolean DEFAULT true,deactivated_at timestamptz);
      INSERT INTO organizations VALUES('${a.orgId}'),('77503d34-97e9-49a8-8c52-8ee30cc7603e');
      INSERT INTO users(id) VALUES('${a.userId}'),('${b.userId}'),('${member.userId}'),('84f5568b-4d6a-4ae1-9a33-48cb2909d59b');
      INSERT INTO user_organizations(user_id,org_id,role) VALUES('${a.userId}','${a.orgId}','owner'),('${b.userId}','${a.orgId}','admin'),('${member.userId}','${a.orgId}','member'),('84f5568b-4d6a-4ae1-9a33-48cb2909d59b','77503d34-97e9-49a8-8c52-8ee30cc7603e','admin')`)
    await admin.query(await readFile(new URL('./fixtures/shared-admin/session-baseline.sql',import.meta.url),'utf8'))
    await admin.query(await readFile(new URL('./fixtures/shared-admin/session-hardening.sql',import.meta.url),'utf8'))
    await admin.query(await readFile(new URL('../../../hivemind/hq-runtime/migrations/company-hq.sql',import.meta.url),'utf8'))
    await admin.query(await readFile(new URL('../../../hivemind/schedule-postgres/migrations/schedule.sql',import.meta.url),'utf8'))
    const sharedMigration=await readFile(new URL('./fixtures/shared-admin/shared.sql',import.meta.url),'utf8')
    // The native Schedule migration already owns these columns. Make the older
    // Core migration's additive statements idempotent for this cross-repo proof.
    await admin.query(sharedMigration.replaceAll('ADD COLUMN actor_user_id uuid;','ADD COLUMN IF NOT EXISTS actor_user_id uuid;'))
    await admin.query(await readFile(new URL('./fixtures/shared-admin/reservation.sql',import.meta.url),'utf8'))
    await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='shared_admin_fixture')
        THEN CREATE ROLE shared_admin_fixture NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
      GRANT USAGE ON SCHEMA hivemind TO shared_admin_fixture;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA hivemind TO shared_admin_fixture;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA hivemind TO shared_admin_fixture;
      GRANT EXECUTE ON FUNCTION hivemind.organization_agent_storage_scope(uuid,uuid) TO shared_admin_fixture`)
    restricted=new Pool({ connectionString:url,options:'-c search_path=hivemind,public -c role=shared_admin_fixture' })
    schedulePool=new Pool({ connectionString:url,options:'-c search_path=hivemind,public -c role=shared_admin_fixture' })
    expect((await restricted.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper:false,rolbypassrls:false })
    await ctx.plugin(SessionStore); await ctx.plugin(Storage); const scope=new ExecutionScope(ctx)
    const store=new PostgresSessionPersistence(ctx,{ connectionStringEnv:'FIXTURE',schema:'hivemind',leaseTtlMs:30000,maxConnections:3,sharedOrganizationAgents:true },restricted)
    const create=async(p:typeof a,id:string,preset:string)=>scope.run(p,()=>store.create({ version:SESSION_FORMAT_VERSION,id:SessionId(id),createdAt:1,isSeeded:false,cwd:'/fixture',agentPreset:preset }))
    expect(await scope.run(b,()=>store.employeeRoomId('runtime'))).toBe(await scope.run(a,()=>store.employeeRoomId('runtime')))
    const created=await Promise.allSettled([create(a,'session-canonical','hivemind-hq'),create(b,'session-canonical','hivemind-hq')])
    expect(created.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    for(const result of created) if(result.status==='fulfilled') await result.value.close()
    expect((await admin.query("SELECT count(*)::int n FROM hivemind.harness_session_events WHERE event_type='turn/start'")).rows[0].n).toBe(0)
    expect((await admin.query('SELECT session_id FROM hivemind.harness_company_hq WHERE org_id=$1',[a.orgId])).rows[0]?.session_id).toBe('session-canonical')
    expect(await scope.run(b,()=>store.employeeRoomId('runtime'))).toBe('session-canonical')
    await scope.run(a,()=>store.validateAdministratorRoom(SessionId('session-canonical')))
    await scope.run(b,()=>store.validateAdministratorRoom(SessionId('session-canonical')))
    await expect(scope.run(member,()=>store.validateAdministratorRoom(SessionId('session-canonical')))).rejects.toThrow()
    const employee=await create(a,'session-employee','hivemind-hyperagents');await employee.close()
    const brain=await create(a,'session-private-brain','hivemind-chat');await brain.close()
    await expect(scope.run(a,()=>store.validateAdministratorRoom(SessionId('session-private-brain')))).rejects.toThrow('administrator_room_required')
    await expect(scope.run(a,()=>store.validateAdministratorRoom(SessionId('session-employee')))).rejects.toThrow('administrator_room_required')
    expect((await scope.run(b,()=>store.stat(SessionId('session-canonical'))))?.header.id).toBe('session-canonical')
    expect((await scope.run(b,()=>store.stat(SessionId('session-employee'))))?.header.id).toBe('session-employee')
    const writer=await scope.run(b,()=>store.open(SessionId('session-canonical'),'write'))
    await writer.append([{ type:'user/message',seq:SessionSeq(0),time:1,surfaceOp:'append',
      data:createUserMessage({ content:[{ type:'text',text:'B instruction' }],source:{ kind:'user',authenticatedActor:{ ...b,name:'B',role:'admin' } } }) }])
    await writer.append([{ type:'hivemind/artifact-created',seq:SessionSeq(1),time:2,data:{ pdf:{ attachmentId:AttachmentId('shared-report'),name:'report.pdf',bytes:4 } } } as never,
      { type:'user/message',seq:SessionSeq(2),time:3,surfaceOp:'append',data:createUserMessage({ source:{ kind:'user' },content:[{ type:'image',attachment:{ attachmentId:AttachmentId('shared-image'),mediaType:'image/png',bytes:1,width:1,height:1 } }] }) }])
    await writer.flush();await writer.close()
    // Real restricted-role persistence authorizes every cold read; only byte storage is a fixture.
    const sessionQuery={ observeSession:async(id:SessionId)=>{
      const handle=await store.open(id,'read');const read=await handle.read();const header=handle.header;await handle.close();return { header,events:read.events,inheritedEventCount:0,[Symbol.dispose]:()=>{} }
    } }
    ctx.provide('sessionQuery',sessionQuery as never)
    const attachments={
      readImage:async(ref:unknown)=>({ ref,data:Uint8Array.of(1) }),
      readFileStream:async function*(){yield Uint8Array.of(37,80,68,70)},
    }
    const commands=new SessionCommandController({ sessions:{ get:()=>undefined },sessionQuery,attachments } as never,{} as never,'/fixture')
    expect((await scope.run(b,()=>commands.fileAttachment({ sessionId:SessionId('session-canonical'),attachmentId:AttachmentId('shared-report') }))).data).toEqual(Uint8Array.of(37,80,68,70))
    expect((await scope.run(b,()=>commands.attachment({ sessionId:SessionId('session-canonical'),attachmentId:AttachmentId('shared-image') }))).data).toBe('AQ==')
    await expect(scope.run(b,()=>commands.fileAttachment({ sessionId:SessionId('session-private-brain'),attachmentId:AttachmentId('shared-report') }))).rejects.toThrow()
    await expect(scope.run(member,()=>commands.attachment({ sessionId:SessionId('session-canonical'),attachmentId:AttachmentId('shared-image') }))).rejects.toThrow()
    const stored=(await admin.query('SELECT user_id,payload FROM harness_session_events WHERE session_id=$1',['session-canonical'])).rows[0]
    expect(stored.user_id).toBe(a.userId)
    expect(stored.payload.data.source.authenticatedActor.userId).toBe(b.userId)

    expect(await scope.run(b,()=>store.stat(SessionId('session-private-brain')))).toBeUndefined()
    expect((await scope.run(b,()=>store.list())).map(item=>item.header.id)).not.toContain('session-private-brain')
    // Native persistence metadata is read through its dedicated scoped APIs, not attached to list snapshots.
    const visible = await scope.run(b,()=>store.list())
    const visibleIds=visible.map(item=>item.header.id)
    expect(await scope.run(b,()=>store.effectivePresets(visibleIds))).toEqual(new Map([
      ['session-canonical','hivemind-hq'],['session-employee','hivemind-hyperagents'],
    ]))
    expect(await scope.run(b,()=>store.startedSessions(visibleIds))).toEqual(new Set(['session-canonical']))
    expect(await scope.run(b,()=>store.effectivePresets([SessionId('session-canonical'),SessionId('session-private-brain')]))).toEqual(new Map([['session-canonical','hivemind-hq']]))
    expect(await scope.run(b,()=>store.startedSessions([SessionId('session-canonical'),SessionId('session-private-brain')]))).toEqual(new Set(['session-canonical']))
    expect(await scope.run(member,()=>store.list())).toEqual([])

    expect(await scope.run(a,()=>store.employeeRoomId('layla'))).toBe(await scope.run(b,()=>store.employeeRoomId('layla')))
    await expect(scope.run(member,()=>store.employeeRoomId('layla'))).rejects.toThrow()
    ctx.provide('agents',{ get:()=>undefined,withoutInitiator:(work:()=>Promise<unknown>)=>work() } as never)
    ctx.provide('sessionController',{ resolveAgent:async()=>({ error:new Error('not due in fixture') }) } as never)
    new ScheduleBackend(ctx,{ connectionStringEnv:'FIXTURE',schema:'hivemind',maxConnections:2,statementTimeoutMs:10000,maxTasksPerUser:100,sharedOrganizationAgents:true },schedulePool)
    const facility=new DomainFacility(ctx,{ backend:POSTGRES_SCHEDULE_BACKEND })
    ctx.storage.mount('domain',facility)
    ctx.provide('storageDomain',facility)
    await ctx.plugin(ScheduleService,{ ownershipRequired:true })
    const ownership=ctx.get('scheduleOwnership') as ScheduleOwnershipPolicy|undefined
    expect(ownership).toBeDefined()
    if(!ownership)throw new Error('native Schedule ownership policy is not installed')
    await admin.query(`INSERT INTO harness_sessions(id,org_id,user_id,variation,header,status)
      VALUES('session-member-personal',$1,$2,'harness','{"agentPreset":"hivemind-chat"}'::jsonb,'active')`,[a.orgId,member.userId])
    const personalRecord=await scope.run(member,()=>ctx.schedule.create(SessionId('session-member-personal'),{
      title:'Member personal task',prompt:'personal delivery',after_seconds:3600,
    }))
    const personalOwner=await scope.run(member,()=> (ctx.get('scheduleOwnership') as ScheduleOwnershipPolicy).bind(SessionId('session-member-personal')))
    const personalTask:ScheduleTask={ sessionId:SessionId('session-member-personal'),record:personalRecord,status:'active',revision:1,ownership:personalOwner }
    expect(await ownership.runAsOwner(personalTask,async()=>scope.require().userId)).toBe(member.userId)
    const record=await scope.run(b,()=>ctx.schedule.create(SessionId('session-employee'),{
      title:'Shared admin task',prompt:'fixture',after_seconds:3600,
    }))
    expect(await scope.run(b,()=>ctx.schedule.list({ sessionId:SessionId('session-employee') }))).toEqual([record])
    const storedTask=(await admin.query('SELECT user_id,actor_user_id,revision FROM harness_scheduled_tasks WHERE id=$1',[record.id])).rows[0]
    expect(storedTask).toEqual({ user_id:a.userId,actor_user_id:b.userId,revision:1 })
    const employeeRow=await admin.query('SELECT user_id,status,header->>\'agentPreset\' AS preset FROM harness_sessions WHERE id=$1',['session-employee'])
    expect(employeeRow.rows[0]).toMatchObject({ user_id:a.userId,status:'active',preset:'hivemind-hyperagents' })
    const bound=await scope.run(b,()=>ownership.bind(SessionId('session-employee')))
    const task:ScheduleTask={ sessionId:SessionId('session-employee'),record,status:'active',revision:1,ownership:bound }
    const deliveredActor=await ownership.runAsOwner(task,async()=>scope.require().userId)
    expect(deliveredActor).toBe(b.userId)
    await expect(ownership.runAsOwner({ ...task,ownership:{ ...bound,userId:member.userId } },async()=>scope.require().userId))
      .rejects.toThrow('schedule_owner_binding_changed')
    await expect(ownership.runAsOwner({ ...task,ownership:{ ...bound,actorUserId:member.userId } },async()=>scope.require().userId))
      .rejects.toThrow('organization_agent_admin_required')
    // An admin in another tenant is not an authorized actor for this task.
    await expect(ownership.runAsOwner({ ...task,ownership:{ ...bound,actorUserId:'84f5568b-4d6a-4ae1-9a33-48cb2909d59b' } },async()=>scope.require().userId))
      .rejects.toThrow('schedule_membership_revoked')
    await admin.query('UPDATE user_organizations SET is_active=false WHERE user_id=$1',[b.userId])
    expect(await scope.run(b,()=>store.list())).toEqual([])
    expect(await scope.run(b,()=>store.effectivePresets([SessionId('session-canonical')]))).toEqual(new Map())
    await expect(scope.run(b,()=>store.employeeRoomId('layla'))).rejects.toThrow()
    await expect(scope.run(b,()=>store.open(SessionId('session-canonical'),'read'))).rejects.toThrow()
    expect(await scope.run(b,()=>ctx.schedule.catalog())).toEqual([])
    await expect(ownership.runAsOwner(task,async()=>scope.require().userId)).rejects.toThrow('schedule_membership_revoked')
    expect((await admin.query('SELECT status FROM harness_scheduled_tasks WHERE id=$1',[record.id])).rows[0].status).toBe('active')
  } finally {await restricted?.end();await schedulePool?.end();await ctx.fiber.dispose();await admin.end()}
},30000)
