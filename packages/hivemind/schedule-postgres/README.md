# Tenant PostgreSQL Schedule provider

The embedded HIVE web profile loads the upstream DSH Schedule package with this external storage provider. Apply the additive `20260929233000_harness_scheduled_tasks` Prisma migration before enabling the profile. The provider uses the same PostgreSQL database and tenant identity as native Harness sessions.

## Ownership and delivery

Every management operation requires the authenticated execution scope and an active organization membership. Task rows and wake rows have forced PostgreSQL row-level security for `(org_id, user_id)`. A composite foreign key binds each task to a session owned by the same identity. Only sessions whose current preset is `hivemind-hyperagents`, `hivemind-chat`, or `hivemind-hq` accept tasks; child agents do not receive Schedule tools. Switching a blank session commits the selected preset before creating a task.

The host timer reads only due task identities in a short transaction with a server-owned scanner flag. It restores the stored session owner, variation, and project before invoking the native session controller. Organization membership is rechecked before delivery. Closed sessions and revoked owners are deactivated. Browsers and live agents are not required for a due task to wake its session.

A PostgreSQL transaction advisory lock serializes each owner's writes and delivery across runner replicas. A runner leaves a live session's due task for the replica holding its session lease. Task state, delivery history, and the next wake target commit together. The native inbox persists a deterministic occurrence key before the task is acknowledged. A retry after that flush reuses the recorded message and recurring target. This prevents duplicate inbox insertion after an interrupted Schedule commit; it does not promise exactly-once external side effects performed by the model.

HQ roots default to paused. Due delivery requires the canonical company HQ pointer and latest tenant-scoped committed HQ mode before waking the session. Apply the HQ runtime's `migrations/company-hq.sql` alongside the native session schema. While paused or noncanonical, the original occurrence stays active and only its scanner retry time moves forward; no model message is admitted. Enabling the canonical HQ allows normal delivery on the next scan. This control does not pause ordinary employee or company-brain chat schedules.

## Configuration

The HIVE bundle explicitly supplies `connectionStringEnv`, `schema`, `pollIntervalMs`, `retryIntervalMs`, `batchSize`, `maxConnections`, `statementTimeoutMs`, and `maxTasksPerUser`. Missing storage or identity fails closed. The production profile polls every five seconds, retries unacknowledged targets after thirty seconds, and bounds each user's retained task count at 100. Delete old tasks to free that quota.

## Model Experience

- Tools: upstream `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` attach to HIVE-MIND Chat and HyperAgents roots.
- Prompt and tokens: the provider adds no model prompt or tokens. Due work becomes a native scheduled user message with the saved instruction.
- KV cache: management does not activate a session; due delivery changes the native conversation normally.

## Verification

Use `DSH_SCHEDULE_TEST_URL` pointing at a disposable localhost database named `schedule_test`. `tests/postgres.spec.ts` exercises actual SQL with a non-superuser, non-BYPASSRLS role. `tests/native.e2e.ts` boots the real Loader, PostgreSQL session persistence, Schedule service, native session controller, and built browser with a deterministic model. It creates and edits a task, closes its agent, observes automatic restoration and a persisted inbox message, reads delivery history, and deletes the task. The fixture owns and drops a random schema.

## Known Limitations and Deferred Work

The runner must remain online. A delivery receipt acknowledges the durable inbox, not successful completion of model work or an external notification. Legacy session-local reminders remain readable history and must be recreated explicitly; they are not silently replayed as host tasks. Project identity is restored from the session; this provider checks organization membership and session ownership, while connected tools retain their own project/resource authorization. Calendar integration and external delivery channels are outside this package.

No separate invariant companion is published: database constraints and authorization predicates enforce ownership at each mutation, and the tests exercise the actual database and delivery path.
