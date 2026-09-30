# HQ Runtime foundation

This Cordis capability extends the native Agent Teams board with immutable company-task requirements and artifact correlations. Native Team tasks own IDs, revisions, dependencies, claims, and completion. Native session persistence owns durability and tenant authorization.

`hivemind_hq_contract` attaches a deadline and acceptance criteria to an existing task, lists the native board, or links saved artifact receipts. A disposable monotonic native Team-service guard prevents contracted tasks from completing without saved artifacts. This is a receipt gate, not semantic acceptance review. Models cannot enable autonomy or grant authority through this tool.

The contract capability is mounted only in the new `hivemind-hq` preset; existing employee presets retain their behavior. The host control service exposes a human-only generated Typert Remote, with persisted mode revisions and compare-and-set updates. HQ starts paused. Pausing cancels live HQ-owned agents and blocks new native Team dispatch; ordinary employee roots remain independent. The PostgreSQL Schedule provider retains paused HQ occurrences without waking the model.

The HIVE deployment composes `ownership` and `ownership-postgres`. Apply `migrations/company-hq.sql` in the same schema as native sessions before mounting the provider. Its unique organization key chooses exactly one canonical HQ session across competing humans and replicas. Enabling flushes the native root, verifies current membership and effective HQ preset, claims ownership atomically, then persists the mode. A second root cannot enable. Schedule admission requires that same owner. Native session leases still own exclusive execution; the company pointer is not another agent or task loop. Ownership is retained while paused or offline; implicit takeover is prohibited.

Artifact links can import committed producer receipts from an exact native Team roster member. The caller cannot supply a foreign session or invent receipt proof. The native Schedule UI projects committed occurrences onto a timezone-aware week calendar without a second schedule store.

Durable dispatch reconciliation, semantic acceptance review, Jev decisions, approval mediation, explicit human ownership transfer, and authenticated browser/restart verification remain required before the complete autonomous runtime can be released.

No invariant companion is published: metadata and receipt checks are enforced at mutation with replay tests. Native Team coordination is experimental and does not support several processes coordinating one team. Cross-session and cross-replica guarantees require further integration and verification.

## Model Experience

One bounded company-contract tool supplements native Team tools. Company evidence, selected playbooks, and skills remain progressive. Contracts and artifact links persist as session events; they are not a second task board or a full prompt dump. Native Team IDs and revisions remain authoritative. The stable tool schema preserves the existing model prefix.
