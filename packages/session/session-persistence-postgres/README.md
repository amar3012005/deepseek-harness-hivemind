# @deepseek-ai/dsh-session-persistence-postgres

PostgreSQL provider for the existing `SessionPersistence` service. Every operation requires the request-local authenticated HIVE execution scope, while each returned handle captures its immutable organization, user, profile, variation, and optional project scope. Events are stored in the backend-owned `harness_session_events.payload` as complete JSONB envelopes and indexed by their original contiguous `seq`; append transactions lock the session cursor and reject gaps without partial writes.

Write handles acquire a time-bounded database lease with a monotonically increasing fencing token. Every append and flush verifies the owner token, fence, and expiry in the same transaction as the durable mutation. A stale process cannot write after another process acquires a newer fence.

Every transaction sets the transaction-local `app.hivemind_org_id` and `app.hivemind_user_id` PostgreSQL settings required by the canonical RLS policies and also includes explicit tenant predicates. `connectionStringEnv` names the environment variable containing the database URL; the URL never enters a resolved profile dump. The validated `schema` setting becomes the connection search path, so HIVE uses its existing `hivemind` schema without relying on a Prisma-only URL parameter or the database role's ambient defaults.
