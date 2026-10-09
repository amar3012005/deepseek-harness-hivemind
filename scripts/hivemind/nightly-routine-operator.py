#!/usr/bin/env python3
"""Managed one-org native Schedule operator. Default inspect; --apply ensures one midnight record.
Run on the release host. No provider email, repairs, model calls, broad rollout or parallel scheduler.
"""
import argparse,json,os,re,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('--native-sha',required=True);p.add_argument('--org',required=True);p.add_argument('--user',required=True);p.add_argument('--session',required=True);p.add_argument('--fixture',action='store_true');p.add_argument('--apply',action='store_true');a=p.parse_args()
assert re.fullmatch('[a-f0-9]{40}',a.native_sha)
for value in [a.org,a.user]:assert re.fullmatch('[a-f0-9-]{36}',value)
assert re.fullmatch('session-[a-z0-9-]{1,120}',a.session)
inspect=lambda n:json.loads(subprocess.check_output(['docker','inspect',n]))[0]
control=inspect('attention-fullstack-control'if a.fixture else'hm-control');runner=inspect('attention-fullstack-runner'if a.fixture else'hivemind-harness-runner-1')
image=inspect(runner['Image']);assert image['Config']['Labels']['org.opencontainers.image.revision']==a.native_sha,'exact_native_revision_required'
for service in [runner,control]:assert service['State']['Running'] and service['State'].get('Health',{}).get('Status')=='healthy'
renv=dict(v.split('=',1)for v in runner['Config']['Env']if'='in v)
secret=renv['HIVE_HARNESS_RUNNER_SERVICE_SECRET'];assert len(secret)>=32
payload={'orgId':a.org,'userId':a.user,'sessionId':a.session,'operation':'ensure'if a.apply else'inspect'}
network=list(control['NetworkSettings']['Networks'])[0];assert (network=='attention-fullstack-20261008')==a.fixture
values={'SERVICE_SECRET':secret,'PAYLOAD':json.dumps(payload,separators=(',',':')),'BASE_URL':'http://attention-fullstack-runner:3080'if a.fixture else'http://harness-runner:3080'}
fd,path=tempfile.mkstemp(prefix='nightly-private-',dir='/root/releases');os.chmod(path,0o600)
code=r'''const c=require('node:crypto');(async()=>{const payload=JSON.parse(process.env.PAYLOAD),now=Math.floor(Date.now()/1000),enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const unsigned=enc({alg:'HS256',typ:'JWT'})+'.'+enc({iss:'hivemind-control-plane',aud:'hivemind-nightly-routine',sub:payload.userId,org_id:payload.orgId,iat:now,exp:now+30,body_sha256:c.createHash('sha256').update(JSON.stringify(payload)).digest('hex')});const jwt=unsigned+'.'+c.createHmac('sha256',process.env.SERVICE_SECRET).update(unsigned).digest('base64url');const response=await fetch(process.env.BASE_URL+'/internal/hivemind/nightly-routine',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+jwt},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});const result=await response.json();console.log(JSON.stringify({status:response.status,operation:payload.operation,result,emailsSent:false,modelCalls:false,repairs:false}));if(response.status!==200)process.exitCode=1})().catch(()=>{console.error('nightly_operator_failed');process.exitCode=1})'''
try:
 with os.fdopen(fd,'w')as out:out.write('\n'.join(k+'='+v for k,v in values.items())+'\n')
 subprocess.run(['docker','run','--rm','--network',network,'--env-file',path,'--entrypoint','node',control['Image'],'-e',code],check=True)
finally:os.unlink(path)
