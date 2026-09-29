# HyperAgents tenant Schedule

Status: implemented

## Decision

Port the upstream Schedule package at `639ed015397290b3745d163aafe02ffee4aa3f84` and its native task UI into the deployed Harness fork. Add an external backend seam to the package and a HIVE-owned PostgreSQL provider. Keep the agent loop and HIVE Core/Control Plane services unchanged. The Prisma migration is additive and remains unapplied to production until release checks pass.

The shared Schedule service owns rules, validation, compare-and-set edits, bounded history, and native inbox delivery. The provider owns authenticated tenant storage and timer discovery. A metadata-only due index permits host-wide discovery without exposing prompts across tenants. Every content operation restores the owner and uses forced RLS. PostgreSQL advisory transaction locks serialize owner operations across replicas; a durable inbox occurrence key closes the retry gap between the session flush and task commit.

## Alternatives and limits

Reusing the old session-local scheduler would duplicate upstream rule/edit/history behavior and would not restore cold sessions. Copying host JSON storage into a multi-tenant runner would lose database ownership enforcement and cross-replica coordination. Importing the entire upstream Harness release would widen the change to unrelated frontend and lifecycle APIs. The selected port adapts to current slots and workspace lifecycle rather than replacing the loop.

Task delivery still depends on a live runner and valid organization membership. Inbox delivery is idempotent for a schedule occurrence, but model side effects retain their existing approval and idempotency rules. Old session-local reminders are historical data and require explicit recreation. Current shell limitations are documented in the UI package README.

## Required evidence

Validate the host and client compilation, task UI behavior, rule/storage regressions, real restricted-role PostgreSQL isolation, replica contention, revoked ownership, transaction rollback, and retry deduplication. Boot the real Loader and built browser with PostgreSQL persistence and a deterministic model, dispose the task's agent, and observe authenticated cold-session restoration and durable delivery. Keep production unchanged during these checks.
