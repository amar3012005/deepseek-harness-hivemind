# HIVE-MIND Harness chat runner

Build the repository-owned runner from the committed `singulance-chat` branch:

```sh
docker build -f deploy/hivemind-chat/Dockerfile -t hivemind/harness-chat:local .
```

The image launches only `dsh --profile hivemind-web`; it does not add another Node application entrypoint. Required runtime values are `DATABASE_URL`, `REDIS_URL`, `HIVE_HARNESS_TICKET_SECRET`, and `HIVEMIND_PARENT_ORIGINS` (a JSON array of exact parent origins). The runner listens on `PORT` (default `3080`) and reports PostgreSQL plus Redis readiness at `/health`.

The canonical database migration is owned by HIVE-MIND. This image validates the `harness_sessions` table at startup and never creates or mutates schema. Build provenance should pin the `singulance-chat` commit rather than copying files from an external checkout.
