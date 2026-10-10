/** Build the attention UI client face and reject stale assembled artifacts. */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

/** Distinctive new implementation markers; the older banner already had a bell. */
export function verifyAttentionClient(bundle) {
  const required = [
    '@deepseek-ai/dsh-client-ui-chat/RuntimeSignalRow.module.css',
    'function runtimeSignalEvidence(',
    'signal.appName',
    'Runtime wake request',
    'Update details',
  ];
  const missing = required.filter(marker => !bundle.includes(marker));
  if (missing.length > 0) throw new Error(`Stale attention client bundle: missing ${missing.join(', ')}`);
}

/** Inspect final bytes, not source presence, timestamps, or the pre-existing bell. */
export function verifyAttentionImage(root) {
  const bundlePath = resolve(root, 'packages/client/ui-chat/lib/client.js');
  verifyAttentionClient(readFileSync(bundlePath, 'utf8'));
  return bundlePath;
}

function run(root, cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd: resolve(root, cwd), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Attention client build failed (${String(result.status)}): ${args.join(' ')}`);
}

/** Run after source overlay; verify-only also runs inside the final immutable image. */
export function main(args = process.argv.slice(2)) {
  const rootAt = args.indexOf('--root');
  if (rootAt !== -1 && !args[rootAt + 1]) throw new Error('--root requires a repository directory');
  const root = rootAt === -1 ? resolve(dirname(fileURLToPath(import.meta.url)), '../..') : resolve(args[rootAt + 1]);
  if (!args.includes('--verify-only')) {
    run(root, '.', ['node_modules/typescript/bin/tsc', '-b', 'packages/client/ui-chat/tsconfig.json']);
    // Direct package config avoids a workspace filter accidentally selecting zero packages.
    run(root, 'packages/client/ui-chat', [
      '../../../node_modules/tsdown/dist/run.mjs', '--env.DSH_BUILD_FACE', 'client', '--config', 'tsdown.config.ts',
    ]);
  }
  console.log(`Verified attention client: ${verifyAttentionImage(root)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
