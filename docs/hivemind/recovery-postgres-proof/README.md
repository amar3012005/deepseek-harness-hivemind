# Native PostgreSQL interruption recovery proof

Verified 2026-10-06, using deployed image `hivemind/harness-chat:sha-8f2d8f7375-runtime-voice` without restarting production.

The focused fixture uses the actual native AgentLoop, SessionPersistence PostgreSQL provider, Schedule service and PostgreSQL Schedule provider. A deterministic model is the only substituted reasoning component. The test saves a genuinely open turn, closes the first host, opens a second host, confirms native crash repair and one persisted inbox delivery, receives one assistant message, and opens a third host to verify no repeated delivery or message. Direct SQL asserts the retained message, inbox and inactive schedule. PostgreSQL uses a non-superuser, non-BYPASSRLS application role; the fixture applies shipped session, Schedule and HQ migrations.

All data belongs to a fresh disposable PostgreSQL database on an internal Docker network. The fixture does not receive production database credentials, company sessions, external transport credentials or host sockets. Read-only images and read-only test source mounts are used. Database scratch is bounded to 256 MiB; runner scratch to 256 MiB plus 16 MiB compiler cache. The launcher caps CPU, memory, PIDs, file size and wall time and removes both containers and the network in `finally`.

## Reproduce

Place the test at `/root/releases/recovery-pg-proof/service-recovery-postgres.spec.ts`, and place the adjacent config and launcher there. The config is mounted beside the runner's native config so workspace module resolution matches that image. Run `python3 /root/releases/recovery-pg-proof/run-recovery-pg-proof.py`. It selects the current runner image but never changes or restarts that runner. Requires existing `postgres:16-alpine` and the already-built immutable runner image.

Test source: `packages/hivemind/hq-runtime/tests/service-recovery-postgres.spec.ts`. It skips without `RECOVERY_ADMIN_DB` and refuses any host/database other than the disposable `fixture-pg/schedule_test` boundary.

Evidence: `/tmp/recovery-pg-proof.log` on the operator Mac; remote fixture source `/root/releases/recovery-pg-proof/`. One test passed, 3.60 seconds total, including 1.33 seconds fixture execution.

## Limits

This proves real PostgreSQL persistence and native recovery composition in the deployed image. It does not force a production process crash or interrupt a live company turn. Existing guard tests separately cover explicit Stop, paused autonomy, pending questions/approvals, completed/rested turns, receipt dedupe and cleanup. Those guards remain unchanged.

The fresh production media audit still returned 10 saved native operations, six completed with artifacts and four failures, zero failures with a `CONFIRMED_IMAGE_NO_OUTPUT` receipt. The configured Muse fallback cannot safely execute against any of those operations. Real Muse output and isolated confirmed-failure fallback were already verified, but production native fallback persistence remains unverified until a genuine eligible primary failure occurs. No failure was fabricated, no unknown operation was retried, and no additional generation was requested for this proof.
