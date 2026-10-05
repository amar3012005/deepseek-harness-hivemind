import subprocess,uuid
suffix=uuid.uuid4().hex[:8];net='recovery-proof-'+suffix;pg='recovery-pg-'+suffix
image=subprocess.check_output(['docker','inspect','hivemind-harness-runner-1','--format','{{.Config.Image}}'],text=True).strip()
def run(args,**kw):return subprocess.run(args,check=True,**kw)
try:
 run(['docker','network','create','--internal',net],stdout=subprocess.DEVNULL)
 run(['docker','run','-d','--name',pg,'--network',net,'--network-alias','fixture-pg','--read-only','--user','999:999','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','0.5','--pids-limit','64','--ulimit','fsize=268435456:268435456','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=256m,uid=999,gid=999','--tmpfs','/tmp:rw,noexec,nosuid,size=16m,uid=999,gid=999','--tmpfs','/var/run/postgresql:rw,noexec,nosuid,size=16m,uid=999,gid=999','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=schedule_test','postgres:16-alpine'],stdout=subprocess.DEVNULL)
 for attempt in range(30):
  r=subprocess.run(['docker','exec',pg,'pg_isready','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if r.returncode==0:break
  import time;time.sleep(.2)
 else:raise RuntimeError('disposable database not ready')
 run(['docker','run','--rm','--name','recovery-test-'+suffix,'--network',net,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','1g','--cpus','1','--pids-limit','128','--ulimit','fsize=67108864:67108864','--tmpfs','/tmp:rw,nosuid,size=256m','--tmpfs','/opt/deepseek-harness/node_modules/.vite-temp:rw,noexec,nosuid,size=16m','--env','RECOVERY_ADMIN_DB=postgresql://postgres@fixture-pg:5432/schedule_test','--env','NODE_OPTIONS=--max-old-space-size=768','--env','TMPDIR=/tmp','--workdir','/opt/deepseek-harness','--mount','type=bind,source=/root/releases/recovery-pg-proof/service-recovery-postgres.spec.ts,target=/opt/deepseek-harness/packages/hivemind/hq-runtime/tests/service-recovery-postgres.spec.ts,readonly','--mount','type=bind,source=/root/releases/recovery-pg-proof/recovery-proof.vitest.config.ts,target=/opt/deepseek-harness/recovery-proof.vitest.config.ts,readonly','--entrypoint','node',image,'node_modules/vitest/vitest.mjs','run','--config','recovery-proof.vitest.config.ts'],timeout=90)
finally:
 subprocess.run(['docker','rm','-f',pg,'recovery-test-'+suffix],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['docker','network','rm',net],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
