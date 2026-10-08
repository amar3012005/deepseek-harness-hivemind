import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wakeBriefing } from '../../packages/hivemind/hq-runtime/src/wake-briefing.ts';
const text = wakeBriefing({ mode: { enabled: false, revision: 0, changedAt: 0 }, tasks: [], calendar: [], wakes: [] }, [], 'runtime-session');
test('routine admin-delegated decisions preserve existing permission boundary', () => {
  for (const clause of ['Act on behalf of the organization administrator', 'Resolve reversible operational choices', 'Task delegation does not grant new access', 'current authenticated session authorization']) assert.ok(text.includes(clause));
});
test('necessary questions retain durable state and do not pause independent work', () => {
  for (const clause of ['existing native blocker/approval state', 'one direct authorized user notification', 'wait only for dependent work', 'Never infer consent from silence']) assert.ok(text.includes(clause));
});
test('private memory retains richer operational context without widening schema or permission', () => {
  for (const clause of ['decisions and rationale', 'ongoing goals', 'not handoffs alone', 'never assume permission to inspect arbitrary personal memory', 'existing approval rules']) assert.ok(text.includes(clause));
  const source = readFileSync(new URL('../../packages/hivemind/runtime/src/index.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('author-pinned history'));
  assert.ok(source.includes('Retain reusable verified lessons'));
  assert.ok(source.includes("private memory author must match the persistent session owner"));
});
