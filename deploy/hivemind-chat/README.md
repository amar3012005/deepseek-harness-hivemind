# HIVE-MIND Harness chat runner

Build the repository-owned runner from the committed `singulance-chat` branch:

```sh
docker build \
  --build-arg DSH_CLIENT_COMMIT_HASH="$(git rev-parse HEAD)" \
  -f deploy/hivemind-chat/Dockerfile \
  -t hivemind/harness-chat:local .
```

Verify the built artifact (rather than a source-tree config dump) with:

```sh
./deploy/hivemind-chat/verify-image.sh
```

The probe launches the image's compiled `dsh` CLI with `--profile hivemind-web`, verifies every native presentation row required by HIVE chat remains enabled, and resolves the shipped `hivemind-chat` preset plus `@deepseek-ai/dsh-hivemind-connected-apps` from the image filesystem. Pass an existing immutable image reference as the first argument to inspect it without rebuilding.

The image launches only `dsh --profile hivemind-web`; it does not add another Node application entrypoint. Required runtime values are `DATABASE_URL`, `REDIS_URL`, `HIVE_HARNESS_TICKET_SECRET`, `HIVEMIND_CONTROL_PLANE_URL`, `HIVE_HARNESS_RUNNER_SERVICE_SECRET`, and `HIVEMIND_PARENT_ORIGINS` (comma-separated exact parent origins). The two HIVE secrets must be distinct and at least 32 bytes. The runner listens on `PORT` (default `3080`) and reports PostgreSQL plus Redis readiness at `/health`.

Profile, recall, memory and employee-directory calls use the narrow tenant-scoped control-plane proxy. The runner does not mount an ICARUS config and never receives a user or HIVE master API credential.

The canonical database migration is owned by HIVE-MIND. This image validates the `harness_sessions` table at startup and never creates or mutates schema. Build provenance should pin the `singulance-chat` commit rather than copying files from an external checkout.
