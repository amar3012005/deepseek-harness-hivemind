# Agent Note: Persistent employee task assignees

Status: implemented

## Problem

HQ scheduled work woke Runtime, which spawned task-specific children or performed employee research inline. Existing employee rooms therefore did not own execution, and generic inline operating guidance contradicted the Chief of Staff role.

## Decision

Native Agent Teams retains the task board, revisions, dependencies and completion transitions. Its host-only persistent assignee binding authenticates both existing live roots through the persistence provider and stores one durable roster reference per employee room. The reference supplies native task ownership without adopting employee Team membership, changing parentSession, granting peer Team rights or handing lifecycle teardown to Runtime. Existing continuable child behavior remains intact.

The Cordis HQ adapter resolves employees through the authenticated directory and native canonical room resolver. Immediate work uses the existing durable room mailbox with stable assignment keys. Future work saves a quiet employee notice now and native Schedule targets that employee room at the saved time. A host-only monotonic Schedule policy validates frozen assignment, persisted planning revision, pause state and dependency readiness before inbox insertion. Denial preserves the original due occurrence for normal provider retry. Native pre-step policy rechecks admitted work before subsequent model requests. Quiet artifact notices import exact saved producer receipts; acceptance still requires the current native revision and Jev review.

Runtime operating context selects persistent employee execution and coordination/review guidance. Ordinary Brain and HyperAgents retain their inline employee behavior. Greetings request concise direct replies; terminal replies and quiet notices do not solicit another conversational response.

## Alternatives considered

Adopting employee roots as continuable children would change their independent Team authority and lifecycle. Keeping a fake lead task owner would obscure the actual producer. A separate task engine would duplicate native persistence, dependencies and scheduling. All are rejected.

## Verification

Focused native fixtures execute and save a content-addressed employee Markdown deliverable, import its receipt, enforce acceptance, and replay the terminal native board. Additional cases verify shared persistent ownership across tasks, tenant-provider denial, absence of child teardown, planning repair and policy-denied Schedule retention. Production canaries establish live immediate and scheduled employee execution separately from controlled model quality.
