import type { HivemindPrincipal } from './index.ts'
export interface AuthenticatedActor { readonly userId:string; readonly orgId:string; readonly name:string; readonly role:string }
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
type SavedEvent={ readonly type:string;readonly seq:number;readonly data:unknown }
function record(value:unknown):value is Record<string,unknown> { return typeof value==='object'&&value!==null&&!Array.isArray(value) }
function answerPayload(value:unknown):readonly { id:string;selected:readonly string[];custom?:string }[]|undefined {
  if(!record(value)||!Array.isArray(value['answers']))return undefined
  const answers:{ id:string;selected:readonly string[];custom?:string }[]=[]
  for(const answer of value['answers']) {
    if(!record(answer)||typeof answer['id']!=='string'||!Array.isArray(answer['selected'])
      ||!answer['selected'].every(option=>typeof option==='string')
      ||(answer['custom']!==undefined&&typeof answer['custom']!=='string'))return undefined
    answers.push({ id:answer['id'],selected:[...answer['selected']],...(answer['custom']===undefined?{}:{ custom:answer['custom'] }) })
  }
  return answers
}
function messageRecord(event:SavedEvent):Record<string,unknown>|undefined {
  if(event.type!=='user/message'||!record(event.data))return undefined
  return event.data
}
function nativeAnswerPayload(message:Record<string,unknown>,callId:string):unknown {
  const content=message['content']
  if(!Array.isArray(content))return undefined
  const text=content.find(block=>record(block)&&block['type']==='text')
  if(!record(text)||typeof text['text']!=='string')return undefined
  try {
    const parsed:unknown=JSON.parse(text['text'])
    if(!record(parsed)||parsed['kind']!=='answer_to_pending_question'||parsed['tool']!=='ask_user_question'||parsed['callId']!==callId)return undefined
    return { answers:parsed['answers'] }
  } catch { return undefined }
}

/** Resolve native answer attribution through its exact immutable reply and saved HIVE witness in one Session. */
export function questionRespondentWitnessForReply(
  events: readonly SavedEvent[], reply: SavedEvent,
): { id: string; seq: number; actor: AuthenticatedActor } | undefined {
  const message=messageRecord(reply)
  if(!message||!record(message['source']))return undefined
  const source=message['source']
  if(source['kind']!=='user-question-reply'||source['outcome']!=='answered'||typeof source['callId']!=='string'||!source['callId'])return undefined
  const callId=source['callId']
  const callEvents=events.filter(event=>event.type==='tool/call'&&event.seq<reply.seq&&record(event.data)
    &&event.data['name']==='ask_user_question'&&event.data['callId']===callId)
  if(callEvents.length!==1)return undefined
  const call=callEvents[0]
  if(!call||!record(call.data))return undefined
  let args:unknown=call.data['arguments']
  if(typeof args==='string') { try { args=JSON.parse(args) } catch { return undefined } }
  if(!record(args)||!Array.isArray(args['questions'])||args['questions'].length===0)return undefined
  const native=answerPayload(nativeAnswerPayload(message,callId))
  if(native===undefined)return undefined
  const witnesses=events.filter(event=>event.seq>reply.seq&&messageRecord(event)!==undefined).filter((event)=>{
    const witness=messageRecord(event)
    const candidate=witness?.['source']
    return record(candidate)&&candidate['kind']==='user'&&candidate['questionCallId']===callId
      &&candidate['questionEventId']===`late-${callId}`&&candidate['questionAnswer']===true
      &&candidate['questionAnswerSubmission']===true&&JSON.stringify(answerPayload({ answers:candidate['questionAnswerPayload'] }))===JSON.stringify(native)
  })
  if(witnesses.length!==1)return undefined
  const witnessEvent=witnesses[0]
  if(witnessEvent===undefined)return undefined
  const witness=messageRecord(witnessEvent)
  const actor=witness?authenticatedActorFromSource(witness['source']):undefined
  return witness&&typeof witness['id']==='string'&&actor?{ id:witness['id'],seq:witnessEvent.seq,actor }:undefined
}
export function authenticatedActorForQuestionReply(events:readonly SavedEvent[],reply:SavedEvent):AuthenticatedActor|undefined {
  return questionRespondentWitnessForReply(events,reply)?.actor
}
/** Only server-produced user, voice, and native room-message sources carry authority. */
export function authenticatedActorFromSource(value: unknown): AuthenticatedActor | undefined {
  if (!value || typeof value!=='object') return undefined
  const source=value as Record<string,unknown>
  const voiceCall = source['kind']==='hivemind-live-voice' && source['plugin']==='hivemind-live-voice'
    && source['form']==='recall'
  if (source['kind']!=='user' && source['kind']!=='schedule' && source['kind']!=='hivemind-runtime-event' && source['kind']!=='hivemind-agent-message'
    && !voiceCall) return undefined
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
