/** Reviewed operator only. No cancellation, provider operation, email, answer, or business replay. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const directory = process.env.RECOVERY_EVIDENCE_DIR ?? '/evidence';
function captured(name, expected) {
  assert.match(expected ?? '', /^[a-f0-9]{64}$/u, 'root-reviewed immutable capture hash required');
  const bytes = fs.readFileSync(`${directory}/${name}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'capture changed');
  return JSON.parse(bytes);
}
const capture = captured('romeo-delegated-blocker-capture-20261008.json', process.env.RECOVERY_DATABASE_CAPTURE_SHA256);
const remote = captured('romeo-pending-remote-capture-20261008.json', process.env.RECOVERY_REMOTE_CAPTURE_SHA256);
assert.equal(capture.readOnly, true);assert.equal(capture.providerCalls, false);
assert.equal(remote.observerOnly, true);assert.equal(remote.cancelSent, false);assert.equal(remote.answersSent, false);
for (const field of ['orgId', 'userId', 'sessionId']) assert.equal(capture[field], remote[field]);
const pending = capture.roomEvents.find(row => Number(row.sequence) === 725 && row.event_type === 'tool/call');
assert(pending, 'exact reviewed original native tool call required');
const call = pending.payload.data;
assert.equal(call.name, 'hivemind_connected_task');assert.equal(call.turn, 11);
assert.equal(call.callId, 'call_U6JJq9fLUlHHjN5N5YP8WFzj');
const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
assert.equal(args.session.id, 'upon');
assert(remote.frames.some(frame => frame.agentId === capture.sessionId && frame.eventId === '0deee9f9-347d-48be-a7d5-2bdc83d5263c'
  && frame.request.questions.some(question => question.id === 'hivemind-connected-app-authorization:upon:googlesheets')));
const assignment = capture.assignment[0].payload.data;
assert.equal(assignment.sessionId, capture.sessionId);assert.equal(assignment.employeeId, capture.employeeId);
const task = capture.rootEvents.find(row => row.event_type === 'team/task' && row.payload.data.task.id === assignment.taskId)?.payload.data.task;
assert(task, 'captured native task required');assert.equal(task.revision, 2);assert.equal(task.status, 'in_progress');
const router = capture.roomEvents.find(row => row.event_type === 'hivemind/composio-session').payload.data;
assert.equal(router.routerSessionId, 'trs_S53KskzCdupx');
const request = {confirmed: true,employeeSessionId: capture.sessionId,taskId: assignment.taskId,taskRevision: task.revision,
  callId: call.callId,callSeq: Number(pending.sequence),turn: call.turn,workflowSessionId: args.session.id,
  routerSessionId: router.routerSessionId,toolkits: ['googlesheets']};
const proof = {version: 1,validatedCaptureOnly: true,cancelSent: false,answersSent: false,providerCalls: false,
  emailCalls: false,source: process.env.VERIFIED_NATIVE_SHA ?? null,rootId: capture.rootId,request};
if (process.argv.includes('--apply')) {
  assert.match(process.env.VERIFIED_NATIVE_SHA ?? '', /^[a-f0-9]{40}$/u, 'verified live native release required');
  const {client} = await import('/canary/client.mjs');
  const native = await client({org: capture.orgId,user: capture.userId});
  // The host method itself requires actual saved user cancellation, exact call/turn,
  // unchanged revision and authenticated same-task ownership. A flag is not a receipt.
  proof.receipt = await native.rpc('hivemindHq/checkpointDelegatedConnection', {agentId: capture.rootId,request});
  assert.equal(proof.receipt.status, 'blocked_reported');assert.equal(proof.receipt.task_id, request.taskId);
  proof.validatedCaptureOnly = false;
}
const output = `${directory}/romeo-postrestart-blocker-migration-20261008.json`;
fs.writeFileSync(output, JSON.stringify(proof,null,2), {mode: 0o600});
console.log(JSON.stringify({validatedCaptureOnly: proof.validatedCaptureOnly,artifact: output,
  checkpointSaved: proof.receipt?.status === 'blocked_reported',cancelSent: false,answersSent: false,providerCalls: false,emailCalls: false}));
