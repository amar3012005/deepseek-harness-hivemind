# HQ Runtime foundation

This Cordis capability extends the native Agent Teams board with immutable company-task requirements and artifact correlations. Native Team tasks own IDs, revisions, dependencies, claims, and completion. Native session persistence owns durability and tenant authorization.

`hivemind_hq_contract` attaches a deadline and acceptance criteria to an existing task, lists the native board, or links saved artifact receipts. A disposable monotonic native Team-service guard prevents contracted tasks from completing without saved artifacts. This is a receipt gate, not semantic acceptance review. Models cannot enable autonomy or grant authority through this tool.

The contract capability is mounted only in the new `hivemind-hq` preset; existing employee presets retain their behavior. The host control service exposes a human-only generated Typert Remote, with persisted mode revisions and compare-and-set updates. HQ starts paused. Pausing cancels live HQ-owned agents and blocks new native Team dispatch; ordinary employee roots remain independent. The PostgreSQL Schedule provider retains paused HQ occurrences without waking the model.

Artifact links can import committed producer receipts from an exact native Team roster member. The caller cannot supply a foreign session or invent receipt proof. The native Schedule UI projects committed occurrences onto a timezone-aware week calendar without a second schedule store.

Company-wide singleton ownership, durable dispatch reconciliation, semantic acceptance review, Jev decisions, approval mediation, and authenticated browser/restart verification remain required before the complete autonomous runtime can be released. Current mode ownership is per HQ root, not company-wide.

No invariant companion is published: metadata and receipt checks are enforced at mutation with replay tests. Native Team coordination is experimental and does not support several processes coordinating one team. Cross-session and cross-replica guarantees require further integration and verification.

## Model Experience

One bounded company-contract tool supplements native Team tools. Company evidence, selected playbooks, and skills remain progressive. Contracts and artifact links persist as session events; they are not a second task board or a full prompt dump. Native Team IDs and revisions remain authoritative. The stable tool schema preserves the existing model prefix.
