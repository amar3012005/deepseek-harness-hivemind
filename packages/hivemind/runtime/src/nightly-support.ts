import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { isRuntimeRoom } from './runtime-decision-memory.ts'
import { z } from 'zod'
/** Validated bounded technical diagnostics; raw business records and secrets cannot enter support email. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Fresh Core canonical Runtime and organization timezone attestation. @mode serial */
    'hivemind/nightly-routine-context'(input:{ agent:Agent;signal:AbortSignal }):Promise<unknown>
  }
}
export const supportCapabilities = ['crm','employee_lifecycle','delegation','memory','voice','attention','artifacts','email','schedule','authorization','runtime'] as const
export const supportCodes = ['invalid_identifier','permission_denied','missing_configuration','tool_contract','delivery_failed','unavailable','unknown'] as const
const coverageSchema=z.object({
  expected:z.number().int().min(0).max(1000),
  inspected:z.number().int().min(0).max(1000),
  missing:z.number().int().min(0).max(1000),
}).strict().refine(c=>c.inspected+c.missing===c.expected)
const unsafeDetail=new RegExp([
  String.raw`\b(?:bearer|basic)\s+\S+`,
  String.raw`\b(?:api[_ \-]?key|access[_ \-]?token|refresh[_ \-]?token|password|secret)\s*[:=]\s*\S+`,
  String.raw`\b(?:sk|ghp|github_pat)[_-][a-z0-9_-]{12,}`,
  String.raw`\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+`,
  String.raw`\b(?:https?|postgres(?:ql)?|redis):\/\/`,
  String.raw`[\w.+-]+@[\w.-]+\.[a-z]{2,}`,
  String.raw`\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b`,
].join('|'),'i')
const technicalText=z.string().min(1).max(1200).refine(text=>
  text===text.trim()&&!/[\u0000-\u001f\u007f]/.test(text)&&!unsafeDetail.test(text))
const detailsSchema=z.object({ functional_area:z.enum(['marketing','finance','sales','operations','product','engineering','hr','support','other']).optional(),task_context:technicalText.optional(),impact:technicalText.optional(),proposed_fix:technicalText.optional(),owner:z.enum(['runtime','hyperagent']),agent_index:z.number().int().min(1).max(1000).optional(),tool:z.string().regex(/^[a-z][a-z0-9_.:-]{0,119}$/).optional(),expected:technicalText,observed:technicalText,recovery:technicalText,prevention:technicalText,evidence:z.array(z.object({ kind:z.enum(['tool_result','task_receipt','schema_validation','coverage_gap']),turn:z.number().int().min(1).max(10000000).optional(),sequence:z.number().int().min(1).max(10000000).optional() }).strict()).min(1).max(5) }).strict().refine(value=>value.owner==='hyperagent'?value.agent_index!==undefined:value.agent_index===undefined)
const issueSchema=z.object({ capability:z.enum(supportCapabilities),code:z.enum(supportCodes),severity:z.enum(['critical','high','medium','low']),count:z.number().int().min(1).max(1000000),cause:z.enum(['confirmed','suspected','unknown']),details:detailsSchema.optional() }).strict()
const supportSchema=z.discriminatedUnion('operation',[z.object({ operation:z.literal('status'),occurrence:z.iso.datetime() }).strict(),z.object({ operation:z.literal('evidence'),occurrence:z.iso.datetime() }).strict(),z.object({ operation:z.literal('submit'),occurrence:z.iso.datetime(),coverage:coverageSchema,issues:z.array(issueSchema).max(20) }).strict()])
export function runtimeSupportReportTool(
  send: (agent: Agent, input: Record<string, JsonValue>, signal: AbortSignal) => Promise<Record<string, JsonValue>>,
) {
  return defineTool({
    name: 'runtime_support_report',
    description: 'Runtime only: read evidence, submit or inspect one detailed technical Nightly report to the server-configured SUPPORT inbox. Keep the ORIGINAL saved native occurrence on delayed delivery/retry. Include validated details for Runtime and every inspected HyperAgent: expected, observed, recovery, prevention and structured technical evidence. Fields are bounded technical summaries, never raw business logs, private memory/transcripts, secrets, names, UUIDs, URLs or arbitrary recipients. Use hyperagent agent_index from the authorized roster order rather than employee names. Missing replies are missing coverage. Read operation evidence before submit to obtain exact correlated findings and native sequence references; copy finding fields verbatim rather than inventing references. Exact occurrence/content dedupes retries; conflicts require status, not resend. Accepted/queued is not delivered, delivered is not read or approval. No repair or access-change authority is granted',
    parameters: {
      operation: { type: 'string', enum: ['submit','status','evidence'], required: true },
      occurrence: { type: 'string', required: true, description: 'Original native scheduled occurrence as UTC RFC3339, not current time after a queue delay.' },
      coverage: { type: 'object', properties: {
        expected: { type: 'integer', required: true, description: '0 through 1000.' },
        inspected: { type: 'integer', required: true, description: '0 through 1000.' },
        missing: { type: 'integer', required: true, description: '0 through 1000; inspected + missing must equal expected.' },
      }, additionalProperties: false, description: 'Required for submit. Runtime plus active employees; unavailable evidence is missing coverage.' },
      issues: { type: 'array', description: 'Required for submit; empty only when inspected evidence supports no issue.', items: { type: 'object', additionalProperties: false, properties: {
        capability: { type: 'string', enum: [...supportCapabilities], required: true },
        code: { type: 'string', enum: [...supportCodes], required: true },
        severity: { type: 'string', enum: ['critical','high','medium','low'], required: true },
        count: { type: 'integer', required: true, description: 'Proven count from 1 through 1000000.' },
        cause: { type: 'string', enum: ['confirmed','suspected','unknown'], required: true },
        details: { type:'object',additionalProperties:false,description:'Validated technical summary; all text fields are single-line, trimmed, 1–1200 characters, without secrets, names, business content, UUIDs, email addresses or URLs.',properties:{
          functional_area:{ type:'string',enum:['marketing','finance','sales','operations','product','engineering','hr','support','other'] },task_context:{ type:'string' },impact:{ type:'string' },proposed_fix:{ type:'string' },
          owner:{ type:'string',enum:['runtime','hyperagent'],required:true },agent_index:{ type:'integer',description:'Required only for HyperAgent: 1–1000 authorized roster ordinal.' },tool:{ type:'string',description:'Optional tool contract name, not arguments or credentials.' },
          expected:{ type:'string',required:true },observed:{ type:'string',required:true },recovery:{ type:'string',required:true },prevention:{ type:'string',required:true },
          evidence:{ type:'array',items:{ type:'object',additionalProperties:false,properties:{ kind:{ type:'string',enum:['tool_result','task_receipt','schema_validation','coverage_gap'],required:true },turn:{ type:'integer' },sequence:{ type:'integer' } } },description:'1–5 structured evidence references; no raw logs or links.',required:true },
        } },
      } } },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: args => args.operation !== 'submit',
    async execute(args, execution) {
      const agent=execution.agent
      if(!agent||!isRuntimeRoom(agent))throw Error('runtime_support_room_required')
      const input=supportSchema.parse(args)
      if(input.operation==='evidence'){requireNightlyOccurrence(agent,input.occurrence);return nightlyReportEvidence(agent,input.occurrence)}
      if(input.operation==='submit'){requireNightlyOccurrence(agent,input.occurrence);requireNightlyReportEvidence(agent,input)}
      return send(agent, JSON.parse(JSON.stringify(input)) as Record<string,JsonValue>, execution.signal)
    },
  })
}

/** Read only this Runtime's persisted review replies; never export raw logs or other sessions. */
export function nightlyReportEvidence(agent:Agent,occurrence:string):Record<string,JsonValue> {
  const events=agent.session.snapshotEvents() as readonly { type:string;seq:number;data:Record<string,unknown> }[]
  const read=(text:unknown,marker:string):Record<string,unknown>|undefined=>{
    if(typeof text!=='string')return
    try {const value:unknown=JSON.parse(text.split('\n').find(line=>line.startsWith(marker))?.slice(marker.length)??'');return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined}catch{return}
  }
  const requests=events.filter(event=>event.type==='hivemind/room-message-queued'&&event.data.senderId===agent.id&&event.data.kind==='question')
    .flatMap((event)=>{const marker=read(event.data.text,'NIGHTLY_REVIEW_REQUEST=');return marker?.['occurrence']===occurrence&&Number.isInteger(marker['agent_index'])?[{ event,index:marker['agent_index'] as number }]:[]}).slice(-1000)
  const replies:JsonValue[]=[]
  let findingCount=0
  for(const { event:request,index } of requests){
    const reply=events.findLast(event=>event.type==='hivemind/room-message-received'&&event.data.kind==='reply'&&event.data.targetId===agent.id&&event.data.senderId===request.data.targetId&&event.data.replyTo===request.data.id&&read(event.data.text,'NIGHTLY_REVIEW_REPLY=')?.['occurrence']===occurrence)
    if(!reply){replies.push({ agent_index:index,status:'missing' });continue}
    const marker=read(reply.data.text,'NIGHTLY_REVIEW_REPLY=')
    if(!marker)continue
    const findings:JsonValue[]=[]
    let invalid=0
    for(const finding of Array.isArray(marker['findings'])?marker['findings']:[]){
      if(findingCount>=20)break
      if(!finding||typeof finding!=='object'){invalid++;continue}
      const details=detailsSchema.safeParse({ ...Object.fromEntries(['functional_area','task_context','impact','proposed_fix','tool','expected','observed','recovery','prevention'].filter(key=>Object.hasOwn(finding,key)).map(key=>[key,(finding as Record<string,unknown>)[key]])),owner:'hyperagent',agent_index:index,evidence:[{ kind:'tool_result',sequence:reply.seq }] })
      if(!details.success||!details.data.functional_area||!details.data.task_context
        ||!details.data.impact||!details.data.proposed_fix){invalid++;continue}
      findings.push(JSON.parse(JSON.stringify(details.data)) as JsonValue);findingCount++
    }
    replies.push({ agent_index:index,status:'received',sequence:reply.seq,findings,invalid_findings:invalid })
  }
  const start=events.findLast(event=>event.type==='turn/start')?.seq??-1
  const runtime_receipts=events.filter(event=>event.seq>start&&event.type==='tool/result').slice(-30).map((event)=>{
    const message=event.data['message'] as { source?:{ callId?:string };content?:{ isError?:boolean }[] }|undefined
    const call=events.findLast(value=>value.type==='tool/call'&&value.data['callId']===message?.source?.callId)
    return { sequence:event.seq,tool:typeof call?.data['name']==='string'?call.data['name']:null,is_error:message?.content?.some(block=>block.isError===true)??false }
  })
  return { occurrence,replies,runtime_receipts,findings_limit:20 }
}

/** Diagnostics must derive from persisted correlated inbox replies or Runtime's own receipts. */
export function requireNightlyReportEvidence(agent:Agent,input:z.infer<typeof supportSchema>):void {
  if(input.operation!=='submit')return
  const events=agent.session.snapshotEvents() as readonly { type:string;seq:number;data:Record<string,unknown> }[]
  const read=(text:unknown,marker:string):Record<string,unknown>|undefined=>{
    if(typeof text!=='string')return
    const line=text.split('\n').find(value=>value.startsWith(marker))
    try {const value:unknown=JSON.parse(line?.slice(marker.length)??'');return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined}catch{return}
  }
  for(const issue of input.issues){
    const detail=issue.details
    if(!detail||!detail.functional_area||!detail.task_context||!detail.impact||!detail.proposed_fix)
      throw Error('nightly_detailed_work_context_required')
    const evidenced=detail.evidence.some((ref)=>{
      const event=events.find(value=>value.seq===ref.sequence)
      if(!event)return false
      if(detail.owner==='runtime')return event.type==='tool/result'
      if(event.type!=='hivemind/room-message-received'||event.data.kind!=='reply'||event.data.targetId!==agent.id)return false
      const reply=event.data,request=events.find(value=>value.type==='hivemind/room-message-queued'&&value.data.id===reply.replyTo)
      if(request?.type!=='hivemind/room-message-queued'||request.data.kind!=='question'
        ||request.data.senderId!==agent.id||request.data.targetId!==reply.senderId)return false
      const asked=read(request.data.text,'NIGHTLY_REVIEW_REQUEST='),answered=read(reply.text,'NIGHTLY_REVIEW_REPLY=')
      if(asked?.['occurrence']!==input.occurrence||asked['agent_index']!==detail.agent_index
        ||answered?.['occurrence']!==input.occurrence||!Array.isArray(answered['findings']))return false
      return answered['findings'].some(value=>value&&typeof value==='object'
        &&['tool','expected','observed','recovery','prevention','functional_area','task_context','impact','proposed_fix'].every(key=>
          (value as Record<string,unknown>)[key]===(detail as unknown as Record<string,unknown>)[key]))
    })
    if(!evidenced)throw Error('saved_correlated_nightly_evidence_required')
  }
}

/** Read only the native Schedule's persisted original occurrence; never current wall clock. */
export function requireNightlyOccurrence(agent:Agent,occurrence:string):void {
  const id='schedule-'+createHash('sha256').update(`${agent.id}\0nightly-routine-check-v1`).digest('hex')
  const found=agent.session.snapshotEvents().some((event)=>{
    if(event.type!=='user/message'||event.data.source.kind!=='schedule')return false
    const sourceOccurrence=event.data.source.occurrenceAt
    const text=event.data.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')
    const line=text.split('\n').find(value=>value.startsWith('reminders_json: '))
    if(!line)return false
    try {
      const entries:unknown=JSON.parse(line.slice('reminders_json: '.length))
      return Array.isArray(entries)&&entries.some((entry:unknown)=>entry&&typeof entry==='object'&&(entry as Record<string,unknown>)['occurrence_at']===sourceOccurrence)&&entries.some((entry:unknown)=>{
        if(!entry||typeof entry!=='object')return false
        const data=entry as Record<string,unknown>
        return data['schedule_id']===id&&data['occurrence_at']===occurrence
      })
    }catch{return false}
  })
  if(!found)throw Error('saved_nightly_occurrence_required')
}
/** Agent-local tools are registered only after the native Runtime owner preparation. */
export function installRuntimeSupportReport(ctx:Context,send:Parameters<typeof runtimeSupportReportTool>[0]):void {
  const installed=new WeakSet<Agent>()
  const prepare=(agent:Agent):void=>{
    if(!isRuntimeRoom(agent)||installed.has(agent))return
    agent.ctx.effect(()=>agent.ctx.tools.register(runtimeSupportReportTool(send)))
    installed.add(agent)
  }
  ctx.effect(()=>ctx.on('agent/created',({ agent })=>prepare(agent)))
  ctx.effect(()=>ctx.on('agent/session-start',({ agent })=>prepare(agent)))
}
