import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyAttentionClient, verifyAttentionImage } from './build-attention-client.mjs';

const current = [
  '@deepseek-ai/dsh-client-ui-chat/RuntimeSignalRow.module.css',
  'function runtimeSignalEvidence(', 'signal.appName', 'Runtime wake request', 'Update details',
].join('\n');

test('rejects the old bell-only bundle that passed the former freshness check', () => {
  assert.throws(() => verifyAttentionClient('data-runtime-notification-bell messageBubble Received by Runtime'), /Stale attention/);
});

test('rejects a partially copied bundle without its new stylesheet', () => {
  assert.throws(() => verifyAttentionClient(current.replace('RuntimeSignalRow.module.css', 'old.module.css')), /RuntimeSignalRow/);
});

test('accepts the new app context, distinct wake label, and style implementation', () => {
  assert.doesNotThrow(() => verifyAttentionClient(current));
});

test('checks final assembled client bytes even when source and emitted JS are current', () => {
  const root = mkdtempSync(join(tmpdir(), 'attention-image-proof-'));
  const dir = join(root, 'packages/client/ui-chat/lib');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'client.js'), 'data-runtime-notification-bell');
    assert.throws(() => verifyAttentionImage(root), /Stale attention/);
    writeFileSync(join(dir, 'client.js'), current);
    assert.equal(verifyAttentionImage(root), join(dir, 'client.js'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
