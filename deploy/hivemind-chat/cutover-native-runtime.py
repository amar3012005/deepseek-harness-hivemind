#!/usr/bin/env python3
"""Runner-only cutover retaining the complete live Compose chain and native noexec protection."""
import argparse
import copy
import fcntl
import hashlib
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.request


def capture(args):
    return subprocess.check_output(args, text=True)


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def migration_inputs(path):
    receipt = json.loads(pathlib.Path(path).read_text())
    source = pathlib.Path(receipt['sourcePath']).resolve(strict=True)
    candidate = pathlib.Path(receipt['candidatePath']).resolve(strict=True)
    if source == candidate or not source.is_file() or not candidate.is_file():
        raise RuntimeError('Migration source/candidate paths are invalid')
    for label, key, file in [('original', 'sourceSha256', source), ('candidate', 'candidateSha256', candidate)]:
        expected = receipt.get(key)
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected) or file_sha256(file) != expected:
            raise RuntimeError('Migration ' + label + ' hash differs from receipt')
    if receipt.get('runtimeEnvironment') != 'HIVE_HARNESS_STEP_FALLBACK_ROUTES' or receipt.get('changedField') != 'llm-retry.config.fallback' or receipt.get('otherProfileValuesPreserved') is not True:
        raise RuntimeError('Unsupported profile migration receipt')
    routes = receipt.get('routes')
    if not isinstance(routes, list) or not 1 <= len(routes) <= 16:
        raise RuntimeError('Migration receipt has an invalid route list')
    primaries = set()
    for route in routes:
        if not isinstance(route, dict) or set(route) - {'fromProvider', 'provider', 'model', 'maxTokens'}:
            raise RuntimeError('Migration receipt contains unsupported route fields')
        if any(not isinstance(route.get(key), str) or not route[key].strip() or len(route[key]) > 200 for key in ('fromProvider', 'provider', 'model')):
            raise RuntimeError('Migration receipt contains an invalid route identity')
        if route['fromProvider'] == route['provider'] or route['fromProvider'] in primaries:
            raise RuntimeError('Migration receipt contains an ambiguous fallback route')
        if 'maxTokens' in route and (not isinstance(route['maxTokens'], int) or isinstance(route['maxTokens'], bool) or route['maxTokens'] < 1):
            raise RuntimeError('Migration receipt contains an invalid output cap')
        primaries.add(route['fromProvider'])
    return receipt, source, candidate, routes, json.dumps(routes, ensure_ascii=False, separators=(',', ':'))


def yaml_json(value):
    # JSON is a YAML subset and quotes paths, env strings, and release values safely.
    def escape_interpolation(item):
        if isinstance(item, str):
            return item.replace('$', '$$')
        if isinstance(item, list):
            return [escape_interpolation(child) for child in item]
        if isinstance(item, dict):
            return {key: escape_interpolation(child) for key, child in item.items()}
        return item
    return json.dumps(escape_interpolation(value), ensure_ascii=False, indent=2) + '\n'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-image', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--migration-receipt', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9-]+', args.release) or not re.fullmatch(r'[0-9a-f]{40}', args.source_sha):
        raise RuntimeError('Invalid release identity')
    migration, profile_source, profile_candidate, routes, routes_env = migration_inputs(args.migration_receipt)
    release_lock = open('/var/lock/hivemind-release.lock', 'a')
    fcntl.flock(release_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    container, service = 'hivemind-harness-runner-1', 'harness-runner'
    info = json.loads(capture(['docker', 'inspect', container]))[0]
    if info['Config']['Image'] != args.expected_image:
        raise RuntimeError('Active image changed')
    artifact = json.loads(capture(['docker', 'image', 'inspect', args.image]))[0]
    if artifact['Architecture'] != 'amd64' or artifact['Config']['Labels']['org.opencontainers.image.revision'] != args.source_sha:
        raise RuntimeError('Image architecture or source differs')
    labels = info['Config']['Labels']
    files = labels['com.docker.compose.project.config_files'].split(',')
    base = ['docker', 'compose', '--env-file', '/root/hivemind/.env', '-p', labels['com.docker.compose.project'], '--profile', 'harness-chat']
    for file in files:
        base += ['-f', file]
    old = json.loads(capture(base + ['config', '--format', 'json']))
    if old['services'][service]['image'] != args.expected_image:
        raise RuntimeError('Compose image differs from live image')
    actual_env = dict(item.split('=', 1) for item in info['Config']['Env'] if '=' in item)
    for key, value in old['services'][service].get('environment', {}).items():
        if value is not None and actual_env.get(key) != str(value):
            raise RuntimeError('Live environment drift: ' + key)
    volumes = old['services'][service].get('volumes', [])
    patch_mounts = [volume for volume in volumes if volume.get('type') == 'bind' and pathlib.Path(volume.get('source', '')).resolve() == profile_source]
    if len(patch_mounts) != 1 or patch_mounts[0].get('read_only') is not True:
        raise RuntimeError('Expected exactly one existing read-only profile patch bind mount')
    patch_mount = patch_mounts[0]
    patch_target = patch_mount.get('target')
    live_patch_mounts = [mount for mount in info.get('Mounts', []) if mount.get('Destination') == patch_target]
    if len(live_patch_mounts) != 1 or live_patch_mounts[0].get('Type') != 'bind' or pathlib.Path(live_patch_mounts[0].get('Source', '')).resolve() != profile_source or live_patch_mounts[0].get('RW') is not False:
        raise RuntimeError('Live profile patch mount differs from the read-only Compose mount')
    root = pathlib.Path('/root/releases/manifests/hyperagents') / args.release
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    override = root / 'native-runtime.yml'
    override.write_text(yaml_json({'services': {service: {
        'image': args.image,
        'environment': {'NARB_DISABLE_NATIVE_CACHE': '1', 'HIVE_HARNESS_STEP_FALLBACK_ROUTES': routes_env},
        'volumes': [{'type': 'bind', 'source': str(profile_candidate), 'target': patch_target, 'read_only': True}],
    }}}))
    previous_cache = old['services'][service].get('environment', {}).get('NARB_DISABLE_NATIVE_CACHE')
    previous_routes = old['services'][service].get('environment', {}).get('HIVE_HARNESS_STEP_FALLBACK_ROUTES')
    (root / 'rollback.yml').write_text(yaml_json({'services': {service: {
        'image': args.expected_image,
        'environment': {'NARB_DISABLE_NATIVE_CACHE': previous_cache, 'HIVE_HARNESS_STEP_FALLBACK_ROUTES': previous_routes},
        'volumes': [{'type': 'bind', 'source': patch_mount['source'], 'target': patch_target, 'read_only': True}],
    }}}))
    candidate = base + ['-f', str(override)]
    new = json.loads(capture(candidate + ['config', '--format', 'json']))
    allowed = copy.deepcopy(old)
    allowed['services'][service]['image'] = args.image
    allowed['services'][service].setdefault('environment', {})['NARB_DISABLE_NATIVE_CACHE'] = '1'
    allowed['services'][service]['environment']['HIVE_HARNESS_STEP_FALLBACK_ROUTES'] = routes_env
    allowed['services'][service]['volumes'][volumes.index(patch_mount)]['source'] = str(profile_candidate)
    if allowed != new:
        raise RuntimeError('Candidate changes more than image/cache/routes and the existing read-only profile mount source')
    ids = capture(['docker', 'ps', '-q']).split()
    before = {item['Name']: item['Id'] for item in json.loads(capture(['docker', 'inspect', *ids]))}
    record = dict(sourceSha=args.source_sha, image=args.image, imageId=artifact['Id'], previousImage=args.expected_image,
                  previousContainerId=info['Id'], files=files, before=before, execute=args.execute,
                  profileMigration=dict(sourcePath=str(profile_source), candidatePath=str(profile_candidate), sourceSha256=migration['sourceSha256'], candidateSha256=migration['candidateSha256'], routes=routes),
                  previousProfileSource=patch_mount['source'], profileMountTarget=patch_target,
                  previousFallbackRoutesEnv=previous_routes,
                  changedFields=['harness-runner.image', 'harness-runner.environment.NARB_DISABLE_NATIVE_CACHE', 'harness-runner.environment.HIVE_HARNESS_STEP_FALLBACK_ROUTES', 'harness-runner.volumes[' + patch_target + '].source'],
                  preservesNoexec=True, preservesDots=True)
    receipt = root / 'release.json'
    receipt.write_text(json.dumps(record, indent=2) + '\n')
    os.chmod(receipt, 0o600)
    if not args.execute:
        print('Validated exact runner-only image/cache change; production unchanged', flush=True)
        return
    secret = actual_env.get('HIVE_HARNESS_RUNNER_SERVICE_SECRET')
    if not secret:
        raise RuntimeError('Drain credential unavailable')
    for observation in range(2):
        request = urllib.request.Request('http://127.0.0.1:3080/internal/hivemind/runner-drain-status', headers={'Authorization': 'Bearer ' + secret})
        with urllib.request.urlopen(request, timeout=5) as response:
            status = json.load(response)
        if status.get('active_turns') != 0:
            raise RuntimeError('Active turn admitted; cutover deferred')
        if observation == 0:
            time.sleep(2)
    subprocess.run(candidate + ['up', '-d', '--no-deps', '--timeout', '60', service], check=True)
    after_ids = capture(['docker', 'ps', '-q']).split()
    after = {item['Name']: item['Id'] for item in json.loads(capture(['docker', 'inspect', *after_ids]))}
    if after.get(info['Name']) == info['Id']:
        raise RuntimeError('Runner was not replaced')
    for name, identity in before.items():
        if name != info['Name'] and after.get(name) != identity:
            raise RuntimeError('Sibling changed: ' + name)
    print('Runner cutover complete; all sibling identities unchanged', flush=True)
    for attempt in range(45):
        live = json.loads(capture(['docker', 'inspect', container]))[0]
        if live['Image'] != artifact['Id']:
            raise RuntimeError('Active image differs')
        if live['State'].get('Health', {}).get('Status') == 'healthy':
            with urllib.request.urlopen('http://127.0.0.1:3080/health', timeout=5) as response:
                if response.status != 200:
                    raise RuntimeError('HTTP health failed')
            record['healthy'] = True
            receipt.write_text(json.dumps(record, indent=2) + '\n')
            print('Production runner healthy; exact image and HTTP health verified', flush=True)
            return
        if live['State']['Status'] in ['exited', 'dead']:
            raise RuntimeError('Runner stopped during startup')
        time.sleep(2)
    raise RuntimeError('Runner health deadline exceeded')


if __name__ == '__main__':
    main()
