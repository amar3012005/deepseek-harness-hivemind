# @deepseek-ai/dsh-hivemind-web-runner

Profile-only host plugin for embedded HIVE chat. It verifies 60-second HMAC-SHA256 bootstrap tickets locally, consumes each Redis `jti` with atomic `GETDEL` under the shared `hive:harness-ticket:` namespace, mints the native Connection cookie with `Secure; HttpOnly; SameSite=None`, and returns no browser bearer token. `/health` checks Redis and PostgreSQL reachability without fabricating a tenant scope.

The ticket secret and Redis URL are read from named environment variables so resolved profile dumps never contain credentials. Parent origins are injected into the SPA as an explicit allowlist; ticket claims remain server-side.
