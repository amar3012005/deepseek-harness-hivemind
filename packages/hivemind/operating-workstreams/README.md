# @deepseek-ai/dsh-hivemind-operating-workstreams

Executes workstream actors selected by the HyperAgents parent runtime in a durable `hivemind/run-plan`. The plugin does not choose actors or replace the native agent loop.

`hivemind_workstream` starts, updates, completes, or fails one planned workstream. An `inline_employee` start freezes the authenticated employee identity and injects its bounded persona into the next native Harness step. `employee_subagent` workstreams are executed by `hivemind_delegate_employee`, which links its native child session to the planned workstream. Main, dynamic-subagent, and workflow actors remain available to the parent through their native Harness capabilities.

Every state change carries the parent operating-run identity and is an append-only Session event so replay and the Web conversation projection show what actually ran. Terminal completion and failure writes are idempotent per plan/workstream, preventing a resumed parent from duplicating a child-generated terminal receipt. Ordinary research, employee, workflow, browser, artifact, and action receipts remain native execution records; this tool is only needed for named inline employee work or progress that has no other receipt. No runtime invariant companion is published because event validation and execution agreement are owned and tested in this package.

The same observer advances the native `todo/write` projection when a workstream starts or completes. At `agent/turn-stopping`, it allows the native turn to end when an answer is visible and closes the remaining plan Todo projection; if tools returned but no answer was delivered, it steers exactly one continuation from the existing plan, evidence, and Todo state. It does not select work, force a phase graph, repeat orientation, or change the native agent loop.

## Verification

Run `pnpm exec vitest run packages/hivemind/operating-workstreams/tests/operating-workstreams.spec.ts`.
