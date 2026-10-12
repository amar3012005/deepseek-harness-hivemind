# SQL fixture provenance

`session-baseline.sql` and `session-hardening.sql` are unchanged copies of the
HIVEMIND parent migrations at source revision
`ce26aec4531abf0fb27e0da40553c9cd79d71be8`:

- `core/prisma/migrations/20260908150000_harness_chat_sessions/migration.sql`
- `core/prisma/migrations/20260914220000_harness_session_hardening/migration.sql`

The guarded `history_test` fixture applies these original tenant RLS policies,
then the migration package's format predecessor and variation-width migrations.
It creates a restricted, non-superuser, non-bypass-RLS test role and uses a fresh
random password per execution. These files are test inputs, not new production
migrations.
