# HIVE-MIND Harness chat runner

Immutable overlays that change `client/ui-primitives` must run `sh deploy/hivemind-chat/rebuild-shared-shell.sh` after their package builds and before image verification. It compiles the primitives library before rebuilding the web shell that seeds its shared namespace. Copy these release scripts into the overlay along with its changed sources. `verify-image.sh` checks every compiled primitive export against the shell namespace and rejects stale shells before profile validation. A plugin-only rebuild cannot publish newly added primitive exports to the browser.

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

### Dreaming read-only connectors

Apply `dream-connectors.sql` before releasing a runner that exposes `/hivemind/dreamer/connectors`. All grants default off. Settings and the Dreaming room show only ACTIVE accounts owned by the authenticated Composio subject; legacy company accounts are explicitly labelled. Consent is per user/account; active company membership is rechecked.

The native Dreamer reuses `dream_read` with complete, version-pinned provider schemas. Positive read operations only; no model-side search, connection management, or app writes. Metadata contracts are tenant-cached for one day by default. Execution pins account/version, validates arguments, checks grants again, and stores a private full receipt plus durable excerpt/provenance before exposing an evidence ID. Flashbacks may cite those IDs alongside memory IDs. Revoking access blocks future reads/evidence use, but does not erase previously shared Flashbacks.

Default configuration: four read contracts per app, 12,000-character schema/result limits; all tunable through the plugin config. Existing chat connector behavior and native nine-tool Dreamer descriptors are retained.
