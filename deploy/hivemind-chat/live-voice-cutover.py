"""Runner-only immutable voice release; credential input is private JSON on stdin."""
import copy
import json
import os
import pathlib
import subprocess
import sys

container, service, expected, image, sha, release = sys.argv[1:]
assert len(sha) == 40 and all(c in '0123456789abcdef' for c in sha)
assert release and '/' not in release and '..' not in release

def capture(args):
    return subprocess.check_output(args, text=True)

info = json.loads(capture(['docker', 'inspect', container]))[0]
assert info['Config']['Image'] == expected, 'Live image changed; stop'
labels = info['Config']['Labels']
files = labels['com.docker.compose.project.config_files'].split(',')
base = ['docker', 'compose', '--env-file', '/root/hivemind/.env', '-p', labels['com.docker.compose.project'], '--profile', 'harness-chat']
for file in files:
    base += ['-f', file]
old = json.loads(capture(base + ['config', '--format', 'json']))
assert old['services'][service]['image'] == expected
actual_env = dict(item.split('=', 1) for item in info['Config']['Env'] if '=' in item)
assert actual_env.get('DSH_HOME') == '/tmp/dsh', 'Unexpected credential home'
for key, value in old['services'][service].get('environment', {}).items():
    assert actual_env.get(key) == str(value), f'Live environment drift: {key}'
artifact = json.loads(capture(['docker', 'image', 'inspect', image]))[0]
assert artifact['Architecture'] == 'amd64'
assert artifact['Config']['Labels']['org.opencontainers.image.revision'] == sha
root = pathlib.Path('/root/releases/manifests/hyperagents') / release
root.mkdir(parents=True, exist_ok=False)
os.chmod(root, 0o700)
home = pathlib.Path('/root/hivemind/secrets/harness-home')
assert not home.exists(), 'Credential home already exists; reconcile explicitly'
home.parent.mkdir(parents=True, exist_ok=True)
os.chmod(home.parent, 0o700)
home.mkdir(mode=0o700)
subprocess.run(['docker', 'cp', f'{container}:/tmp/dsh/.', str(home)], check=True)
os.chown(home, 1000, 1000)
os.chmod(home, 0o700)
record = json.load(sys.stdin)
assert record.get('kind') == 'grant' and isinstance(record.get('payload'), dict), 'Expected native subscription grant'
private_input = home / '.voice-grant-input.json'
fd = os.open(private_input, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    json.dump(record, stream)
os.chown(private_input, 1000, 1000)
try:
    code = """import fs from 'node:fs'; import {createRequire} from 'node:module';
const {parseDocument}=createRequire('/opt/deepseek-harness/packages/credentials/credentials-local/package.json')('yaml');
const p='/credentials/.credentials.yaml'; const d=parseDocument(fs.readFileSync(p,'utf8'));
if(d.errors.length) throw Error('Invalid credential document');
if(!d.has('records'))d.set('records',{});
d.get('records').set('llm-pi-ai/openai-codex',JSON.parse(fs.readFileSync('/credentials/.voice-grant-input.json','utf8')));
fs.writeFileSync(p,d.toString(),{mode:0o600});fs.chmodSync(p,0o600);
"""
    subprocess.run(['docker', 'run', '--rm', '--network', 'none', '-v', f'{home}:/credentials', '--entrypoint', 'node', image, '--input-type=module', '-e', code], check=True)
finally:
    private_input.unlink(missing_ok=True)
override = root / 'voice.yml'
override.write_text(f'services:\n  {service}:\n    image: {image}\n    volumes:\n      - type: bind\n        source: {home}\n        target: /tmp/dsh\n')
new_cmd = base + ['-f', str(override)]
new = json.loads(capture(new_cmd + ['config', '--format', 'json']))
allowed = copy.deepcopy(old)
allowed['services'][service]['image'] = image
volumes = new['services'][service].get('volumes', [])
previous = old['services'][service].get('volumes', [])
assert not any(v.get('target') == '/tmp/dsh' for v in previous)
assert len(volumes) == len(previous) + 1
added = [v for v in volumes if v.get('target') == '/tmp/dsh']
assert len(added) == 1 and added[0]['type'] == 'bind' and added[0]['source'] == str(home) and not added[0].get('read_only', False)
assert [v for v in volumes if v.get('target') != '/tmp/dsh'] == previous
allowed['services'][service]['volumes'] = volumes
assert allowed == new, 'Candidate changed unrelated managed configuration'
ids = capture(['docker', 'ps', '-q']).split()
before = {x['Name']: x['Id'] for x in json.loads(capture(['docker', 'inspect', *ids]))}
receipt = dict(previousImage=expected, image=image, sourceSha=sha, imageId=artifact['Id'], files=files, credentialHome=str(home), before=before, rollbackCommand=base + ['up', '-d', '--no-deps', service])
(root / 'release.json').write_text(json.dumps(receipt, indent=2) + '\n')
os.chmod(root / 'release.json', 0o600)
print('Validated runner-only image and protected credential mount; rollback recorded', flush=True)
subprocess.run(new_cmd + ['up', '-d', '--no-deps', '--timeout', '60', service], check=True)
after = {x['Name']: x['Id'] for x in json.loads(capture(['docker', 'inspect', *capture(['docker', 'ps', '-q']).split()]))}
assert after.get(info['Name']) != info['Id']
for name, identity in before.items():
    if name != info['Name']:
        assert after.get(name) == identity, f'Unexpected sibling change: {name}'
print(f'Cutover complete; siblings unchanged; receipt {root}', flush=True)
