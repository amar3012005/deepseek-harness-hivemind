# Brain survives a Postgres blip

Status: implemented

## Decision

Every Brain Postgres plugin uses two shared helpers from `@deepseek-ai/dsh-hivemind-execution-scope` (`postgres-resilience.ts`):

- `probePostgresAtBoot` retries the boot reachability probe with doubling delay. `initAttempts` (default 1) and `initRetryDelayMs` (default 1000) are validated `Config` fields of session-persistence, schedule and HQ ownership. The HIVE profile sets 5 attempts from 1 s, so a boot rides out about 15 s of refused or timed-out connections before failing.
- `containPoolErrors` attaches an `error` listener to every production `pg.Pool` (the plugins above plus dreamer and attention). pg-pool emits `error` when an idle client loses its connection; without a listener Node ends the process. With it the failure is logged, pg-pool discards that client, and the next query opens a new connection. Queries that were running on the dropped connection still reject to their callers.

## Evidence

The Runtime lineage exited at boot on `connect ECONNREFUSED` and `Connection terminated due to connection timeout` on 27 Oct and restarted three times (Runtime-Runner `281899704b`, `418bd53acf`). Brain's database is on the same host as its runner, so a refused connection is rarer, but a Postgres restart during a Brain release would end the same way.

## Rejected

A process-wide `uncaughtException` handler was rejected: it would also hide real defects. Retrying forever at boot was rejected: a misconfigured database must still fail the release visibly.
