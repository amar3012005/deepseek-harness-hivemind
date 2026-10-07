/** Opt-in actual restricted-role proof in a disposable shared_admin_test database. */
import { SessionCommandController } from '../../../api/session-controller/src/commands.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import { expect,it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore,{ SESSION_FORMAT_VERSION,SessionId,SessionSeq } from '@deepseek-ai/dsh-session'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { PostgresSessionPersistence } from '@deepseek-ai/dsh-session-persistence-postgres'
import ScheduleBackend from '../../../hivemind/schedule-postgres/src/index.ts'
import { createAtScheduleRecord,ScheduleId } from '@deepseek-ai/dsh-schedule'
const url=process.env.DSH_SHARED_ADMIN_TEST_DATABASE_URL
it.skipIf(!url)('shares canonical native rooms and schedules with active admins while retaining human authority and Brain privacy',async()=>{
  if(new URL(url!).pathname!=='/shared_admin_test') throw Error('disposable_database_required')
  const admin=new Pool({ connectionString:url,options:'-c search_path=hivemind,public' })
  const a={ orgId:'67503d34-97e9-49a8-8c52-8ee30cc7603e',userId:'54f5568b-4d6a-4ae1-9a33-48cb2909d59b',profile:'hivemind-chat' as const,variation:'harness' }
  const b={ ...a,userId:'64f5568b-4d6a-4ae1-9a33-48cb2909d59b' }, member={ ...a,userId:'74f5568b-4d6a-4ae1-9a33-48cb2909d59b' }
  const ctx=new Context(); let restricted:Pool|undefined, schedulePool:Pool|undefined
  try {
    await admin.query(`CREATE SCHEMA hivemind; SET search_path=hivemind,public;
      CREATE TABLE organizations(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE user_organizations(user_id uuid,org_id uuid,role text,is_active boolean DEFAULT true,deactivated_at timestamptz);
      INSERT INTO organizations VALUES('${a.orgId}'); INSERT INTO users(id) VALUES('${a.userId}'),('${b.userId}'),('${member.userId}');
      INSERT INTO user_organizations(user_id,org_id,role) VALUES('${a.userId}','${a.orgId}','owner'),('${b.userId}','${a.orgId}','admin'),('${member.userId}','${a.orgId}','member')`)
    await admin.query(await readFile('/shared-admin-fixtures/session-baseline.sql','utf8'))
    await admin.query(await readFile('/shared-admin-fixtures/session-hardening.sql','utf8'))
    await admin.query(await readFile(new URL('../../../hivemind/hq-runtime/migrations/company-hq.sql',import.meta.url),'utf8'))
    await admin.query(await readFile(new URL('../../../hivemind/schedule-postgres/migrations/schedule.sql',import.meta.url),'utf8'))
    await admin.query(await readFile('/shared-admin-fixtures/shared.sql','utf8'))
    await admin.query(`CREATE ROLE shared_admin_fixture NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA hivemind TO shared_admin_fixture;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA hivemind TO shared_admin_fixture;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA hivemind TO shared_admin_fixture;
      GRANT EXECUTE ON FUNCTION hivemind.organization_agent_storage_scope(uuid,uuid) TO shared_admin_fixture`)
    restricted=new Pool({ connectionString:url,options:'-c search_path=hivemind,public -c role=shared_admin_fixture' })
    schedulePool=new Pool({ connectionString:url,options:'-c search_path=hivemind,public -c role=shared_admin_fixture' })
    expect((await restricted.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper:false,rolbypassrls:false })
    await ctx.plugin(SessionStore); const scope=new ExecutionScope(ctx)
    const store=new PostgresSessionPersistence(ctx,{ connectionStringEnv:'FIXTURE',schema:'hivemind',leaseTtlMs:30000,maxConnections:3,sharedOrganizationAgents:true },restricted)
    const create=async(p:typeof a,id:string,preset:string)=>scope.run(p,()=>store.create({ version:SESSION_FORMAT_VERSION,id:SessionId(id),createdAt:1,isSeeded:false,cwd:'/fixture',agentPreset:preset }))
    const root=await create(a,'session-canonical','hivemind-hq'); await root.close()
    await admin.query('INSERT INTO harness_company_hq(org_id,user_id,session_id) VALUES($1,$2,$3)',[a.orgId,a.userId,'session-canonical'])
    const employee=await create(a,'session-employee','hivemind-hyperagents');await employee.close()
    const brain=await create(a,'session-private-brain','hivemind-chat');await brain.close()
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
    expect((await scope.run(b,()=>commands.fileAttachment({ sessionId:SessionId('session-canonical'),attachmentId:AttachmentId('shared-report') }))).data).toBe('JVBERg==')
    expect((await scope.run(b,()=>commands.attachment({ sessionId:SessionId('session-canonical'),attachmentId:AttachmentId('shared-image') }))).data).toBe('AQ==')
    await expect(scope.run(b,()=>commands.fileAttachment({ sessionId:SessionId('session-private-brain'),attachmentId:AttachmentId('shared-report') }))).rejects.toThrow()
    await expect(scope.run(member,()=>commands.attachment({ sessionId:SessionId('session-canonical'),attachmentId:AttachmentId('shared-image') }))).rejects.toThrow()
    const stored=(await admin.query('SELECT user_id,payload FROM harness_session_events WHERE session_id=$1',['session-canonical'])).rows[0]
    expect(stored.user_id).toBe(a.userId)
    expect(stored.payload.data.source.authenticatedActor.userId).toBe(b.userId)

    expect(await scope.run(b,()=>store.stat(SessionId('session-private-brain')))).toBeUndefined()
    expect((await scope.run(b,()=>store.list())).map(item=>item.header.id)).not.toContain('session-private-brain')
    expect(await scope.run(a,()=>store.employeeRoomId('layla'))).toBe(await scope.run(b,()=>store.employeeRoomId('layla')))
    await expect(scope.run(member,()=>store.employeeRoomId('layla'))).rejects.toThrow()
    ctx.provide('agents',{ get:()=>undefined } as never)
    const backend=new ScheduleBackend(ctx,{ connectionStringEnv:'FIXTURE',schema:'hivemind',pollIntervalMs:100,retryIntervalMs:1000,batchSize:10,maxConnections:2,statementTimeoutMs:10000,maxTasksPerUser:100,sharedOrganizationAgents:true },schedulePool)
    const record=createAtScheduleRecord(ScheduleId('shared-admin-task'),'fixture',new Date(Date.now()-1000).toISOString(),0,'Fixture')
    await scope.run(b,()=>backend.manage(async tasks=>tasks.put(record.id,{ sessionId:SessionId('session-employee'),record,status:'active' })))
    expect((await admin.query('SELECT user_id,actor_user_id FROM harness_scheduled_tasks WHERE id=$1',[record.id])).rows[0]).toEqual({ user_id:a.userId,actor_user_id:b.userId })
    expect(await scope.run(a,()=>backend.manage(async tasks=>[...tasks.entries()].length))).toBe(1)
    let deliveredActor:string|undefined
    await backend.dispatch(async()=>{deliveredActor=scope.require().userId})
    expect(deliveredActor).toBe(b.userId)
    await admin.query('UPDATE user_organizations SET is_active=false WHERE user_id=$1',[b.userId])
    await expect(scope.run(b,()=>store.employeeRoomId('layla'))).rejects.toThrow()
    await expect(scope.run(b,()=>store.open(SessionId('session-canonical'),'read'))).rejects.toThrow()
    await admin.query('UPDATE harness_scheduled_due SET due_at=now() WHERE task_id=$1',[record.id]);deliveredActor=undefined
    await backend.dispatch(async()=>{deliveredActor=scope.require().userId});expect(deliveredActor).toBeUndefined()
    expect((await admin.query('SELECT status FROM harness_scheduled_tasks WHERE id=$1',[record.id])).rows[0].status).toBe('inactive')
  } finally {await restricted?.end();await schedulePool?.end();await ctx.fiber.dispose();await admin.end()}
},30000)
