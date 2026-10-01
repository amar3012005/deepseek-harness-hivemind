# Scheduled memory writes

Native Harness behavior shared by HIVEMIND-chat and HyperAgents.

## Destination contracts

- HIVEMIND is the company brain. Company writes from automatic tasks require a human grant captured by `schedule_create`, before activation.
- Declare `memory_destination` (`personal`, `organization`, `project`) and `memory_project` for project writes. The grant records the schedule ID, exact prompt hash, destination, project, and decision in the owning Session. Persistence must acknowledge it before schedule activation.
- Declined, missing, changed-prompt, mixed-batch, or mismatched-destination grants return a canonical cancelled save result during execution. They never open a human question in an unattended scheduled turn. Stop that write without retrying.
- Dedicated Dreamer uses `dream_save` and its tenant-scoped Flashbacks project. Legacy native Dreamer reminders explicitly requesting Flashbacks also resolve that reserved project through authenticated storage, force project scope and derived metadata, and avoid per-write approval. An arbitrary model-provided project UUID is not an approval exemption.
- `hyperagents_memory` is private operating history, not company memory. Its existing authenticated save path needs no company-memory approval. Do not send private operating records to generic company save tools.

## Read contracts and recovery

Use `{operation:"recall",recall:{query:"question",limit:25}}` or `{operation:"entities",entities:{query:"name",limit:10}}`. Limits are integers 1–25. One unambiguous duplicate read envelope is unwrapped; oversized integer read limits are capped at 25. Unknown fields, mixed envelopes, malformed values and writes retain strict validation.

Every external company save first requires an acknowledged Session journal containing its operation key; a journal outage returns indeterminate without posting a write. Scheduled company saves include the native occurrence identity in their idempotency key. Retrying the same occurrence keeps the key; separate occurrences get separate keys. Interactive keys retain their pre-upgrade format. Reconcile earlier interrupted scheduled writes through the authenticated save-status API before issuing another write. Missing recall matches do not prove that a save failed. An unavailable status endpoint returns an indeterminate result without a POST. Batch results are completed only when every item confirms a successful save.

## Owners

- `packages/hivemind/memory/src/index.ts`: canonical read envelopes, creation permission provider, unattended save authorization and batch receipt state.
- `packages/schedule/schedule/src/index.ts`: optional profile permission hook before native schedule activation; trusted Host `ensure` workflows retain their own policies.
- `packages/schedule/schedule/src/tools.ts` and `types.ts`: declared destination contract.
- `packages/hivemind/dreamer/src/index.ts`: authenticated reserved Flashbacks resolution.
- `packages/hivemind/runtime/src/index.ts`: occurrence idempotency, interrupted-write reconciliation, company-brain skill.

## Checks

928 focused tests passed in Memory, Runtime, Dreamer, and Schedule packages; 14 environment-dependent tests skipped. Host and client TypeScript projects passed. The real native Schedule tool also verifies destination forwarding before activation and prevents activation when permission persistence fails. Production deployment and authenticated canary evidence are recorded separately after release.
