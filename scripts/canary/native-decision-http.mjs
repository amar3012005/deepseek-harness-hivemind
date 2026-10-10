/** Isolated live-provider canary. No inbox, company memory, outreach or agent wake. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope';
const {createOpenRouterDecisionPlugin}=await import(process.env.DECISION_CANARY_MODULE);
const {assessNativeAttention}=await import(process.env.DECISION_CANARY_POLICY_MODULE);
if(!process.env.HIVEMIND_DECISION_ENDPOINT||!process.env.HIVEMIND_DECISION_API_KEY_REF)throw Error('explicit canary endpoint and credential reference required');
let providerHttpStatus;
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(...args)=>{const response=await nativeFetch(...args);providerHttpStatus=response.status;return response};
const ctx=new Context();
await ctx.plugin(ExecutionScope);
await ctx.plugin(Credentials,{path:'/tmp/decision-canary-no-stored-credentials.yaml',watch:false});
await ctx.plugin(createOpenRouterDecisionPlugin({enabled:true,endpoint:process.env.HIVEMIND_DECISION_ENDPOINT,apiKeyRef:process.env.HIVEMIND_DECISION_API_KEY_REF,gatewayTokenRef:process.env.HIVEMIND_DECISION_GATEWAY_TOKEN_REF,timeoutMs:Number(process.env.DECISION_CANARY_TIMEOUT_MS||3000)}));
const auth=process.env.DECISION_CANARY_TOKEN||randomBytes(32).toString('hex');
const scenarios={company:'Fictional Acme team finished the planned internal release check; no blocker remains.',blocker:'Fictional Acme shipping task cannot proceed: its authorized internal API rejects every request; investigate the error and report a fix plan.',user:'Fictional reviewer has an important schedule update: tomorrow’s meeting moved one hour later.',promotion:'Unsolicited generic newsletter advertising an unrelated paid product.',ambiguous:'Fictional note says something might have changed, without identifiable task, person or impact.',disabled:'Fictional urgent blocker in an activity type explicitly disabled by saved settings.'};
const server=createServer(async(req,res)=>{
 if(req.headers.authorization!==`Bearer ${auth}`){res.writeHead(401).end();return}
 const scenario=new URL(req.url,'http://localhost').pathname.slice(1);
 if(!(scenario in scenarios)){res.writeHead(404).end();return}
 providerHttpStatus=undefined;
 const started=performance.now();
 try{const result=await ctx.hivemindExecutionScope.run({orgId:'fictional-canary-only',userId:'fictional-reviewer',profile:'hivemind-chat',variation:'harness'},()=>assessNativeAttention(ctx.hivemindDecision,{toolkit:'fictional-source',data:{activity_type:'scenario',text:scenarios[scenario]}},{enabled:true,revision:'fictional-revision',sessionId:'fictional-runtime'},scenario==='disabled'?{disabledActivityTypes:['scenario']}:{},AbortSignal.timeout(Number(process.env.DECISION_CANARY_TIMEOUT_MS||3000)+1000)));
  res.setHeader('content-type','application/json');res.end(JSON.stringify({scenario,...result,providerHttpStatus,latencyMs:Math.round(performance.now()-started),delivery:'not_attempted',actualWake:false}));
 }catch{res.writeHead(503).end(JSON.stringify({scenario,error:'canary_failed'}))}
});
await new Promise(resolve=>server.listen(process.env.DECISION_CANARY_SERVER==='1'?18086:0,process.env.DECISION_CANARY_SERVER==='1'?'0.0.0.0':'127.0.0.1',resolve));
if(process.env.DECISION_CANARY_SERVER==='1') { console.log('fictional native HTTP canary ready'); await new Promise(()=>{}); }
try{for(const scenario of Object.keys(scenarios)){const {stdout}=await promisify(execFile)('curl',['--silent','--show-error','--max-time','6','--header',`Authorization: Bearer ${auth}`,`http://127.0.0.1:${server.address().port}/${scenario}`]);console.log(stdout)}}catch{console.log(JSON.stringify({error:'HTTP client unavailable or failed; no inference result claimed'}))}finally{await new Promise(resolve=>server.close(resolve));process.exitCode=0;}
