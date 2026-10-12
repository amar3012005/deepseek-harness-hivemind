# Tenant PostgreSQL Schedule provider

The embedded HIVE web profile loads the upstream DSH Schedule package with this external storage provider. Apply the runner-owned additive `migrations/schedule.sql` in the configured native session schema before enabling the profile. The integration tests run this same shipped SQL; Core and Control Plane are not migration owners. The provider uses the same PostgreSQL database and tenant identity as native Harness sessions.

## Ownership and delivery

Every management operation requires the authenticated execution scope and an active organization membership. Task rows and wake rows have forced PostgreSQL row-level security for `(org_id, user_id)`. A composite foreign key binds each task to a session owned by the same identity. Only sessions whose current preset is `hivemind-hyperagents`, `hivemind-chat`, or `hivemind-hq` accept tasks; child agents do not receive Schedule tools. Switching a blank session commits the selected preset before creating a task.

The native Schedule timer selects deadlines from its persisted domain. Before delivery, the provider revalidates the saved session, current preset, organization membership, and authenticated actor, then restores the stored owner, variation, and project for the native session controller. A revoked or otherwise inaccessible owner is refused without fabricating a receipt; the saved task remains available for explicit repair or deletion. Browsers and live agents are not required for an eligible due task to wake its session.

A PostgreSQL transaction advisory lock and revision compare-and-swap serialize each owner's task writes across runner replicas. A separate session advisory lock protects delivery ownership; native session leases continue to arbitrate live agents. Task state, delivery history, and the compatibility due index commit together. The native inbox persists a deterministic occurrence key before the task is acknowledged. A retry after that flush reuses the recorded message and recurring target. This prevents duplicate inbox insertion after an interrupted Schedule commit; it does not promise exactly-once external side effects performed by the model.

HQ roots default to paused. Due delivery requires the canonical company HQ pointer and latest tenant-scoped committed HQ mode before waking the session. Apply the HQ runtime's `migrations/company-hq.sql` alongside the native session schema. While paused or noncanonical, the original task remains active and no model message is admitted; a committed HQ mode or team-state event asks native Schedule to reconsider it. This control does not pause ordinary employee or company-brain chat schedules.

## Configuration

The provider accepts `connectionStringEnv` and `schema`, with optional `sharedOrganizationAgents`, `maxConnections`, `statementTimeoutMs`, and `maxTasksPerUser`. The native Schedule timer owns due selection and retry lifecycle; this adapter has no polling, retry, or batch scheduler. HIVE configures the tenant provider as the `schedule` storage-domain backend and requires its ownership policy. Missing storage or identity fails closed. The default per-owner task limit is 100; delete old tasks to free that quota.

## Model Experience

- Tools: upstream `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` attach to HIVE-MIND Chat and HyperAgents roots.
- Prompt and tokens: the provider adds no model prompt or tokens. Due work becomes a native scheduled user message with the saved instruction.
- KV cache: management does not activate a session; due delivery changes the native conversation normally.

## Verification

Use `DSH_SCHEDULE_TEST_URL` pointing at a disposable local `session_persistence_test` database. `tests/postgres.spec.ts` exercises the native Schedule service and StorageDomain over the PostgreSQL provider with a non-superuser, non-BYPASSRLS role, including tenant fencing, restart, receipt retention, shared actor revocation, membership revocation, and fail-closed ownership migration. `tests/native.e2e.ts` boots the real Loader, PostgreSQL session persistence, Schedule service, native session controller, and built browser with a deterministic model. It creates and edits a task, closes its agent, observes automatic restoration and a persisted inbox message, reads delivery history, and deletes the task. Each fixture owns and drops a random schema.

## Known Limitations and Deferred Work

The runner must remain online. A delivery receipt acknowledges the durable inbox, not successful completion of model work or an external notification. Legacy session-local reminders remain readable history and must be recreated explicitly; they are not silently replayed as host tasks. Project identity is restored from the session; this provider checks organization membership and session ownership, while connected tools retain their own project/resource authorization. Calendar integration and external delivery channels are outside this package.

No separate invariant companion is published: database constraints and authorization predicates enforce ownership at each mutation, and the tests exercise the actual database and delivery path.
