# HyperAgents production handoff — 2026-09-29

## Start on new MacBook

Canonical source: `https://github.com/amar3012005/deepseek-harness-hivemind.git`, branch `codex/hyperagents-production-ui`. This branch contains production Harness composition plus HyperAgents-only employee picker, Humation-avatar/agent panel, right-side Preview, durable PDF attachment/download path, and duplicate-render suppression. It does **not** require Core, Control Plane, or outer HIVE frontend changes.

```sh
git clone --single-branch --branch codex/hyperagents-production-ui \
  https://github.com/amar3012005/deepseek-harness-hivemind.git
cd deepseek-harness-hivemind
git status --short
git rev-parse HEAD
```

At handoff, code tip before this document was `628de40cd26e4241329d7e7c58e56133c97b17da`. Record the new document commit SHA after clone. Do not work from the older `deepseek-harness-hivemind-hyperagents` checkout or `singulance-chat` branch. Create a `codex/<task>` branch from this tip for further fixes; preserve the source branch as a reproducible baseline.

## Live production state and open gate

- Single-server Compose project: `hivemind`; service: `harness-runner`; companion: `harness-tunnel`.
- **Currently live and healthy:** `hivemind/harness-chat:sha-28db83c00a` (`hivemind-harness-runner-1`), zero restarts at handoff. Tunnel also running with zero restarts.
- Candidate `hivemind/harness-chat:sha-628de40cd2` built on native `linux/amd64` host and passed `deploy/hivemind-chat/verify-image.sh`, but was rolled back after authenticated PDF canary failed because Playwright Chromium headless shell was absent at runtime. Do not redeploy that image unchanged. PDF repair belongs to next owner.
- Candidate image ID: `sha256:3484e6611ea9b2cf98e21c4d64f2a2b5448af6d46b373d94e386ef524e3f1d1b`. Rollback image ID: `sha256:bdf6eaa28920c4dd9e394f2f559449521a86d9f2a15911d890ed98034269fe8b`.
- Existing rollback tag: `hivemind/harness-chat:rollback-before-628de40cd2`.
- Existing versioned overrides on server: `/root/releases/manifests/hyperagents/20260929T-release/hyperagents-compose-28db83c00a.yml` and `hyperagents-compose-628de40cd2.yml` in that directory. Inspect before reuse; do not assume they match a future image.
- Local `deepseek.singulancelabs.com` is a macOS launchd preview runner with a different admission path. Its mount/tool results are not production acceptance evidence.

## Fastest safe build/release path

Native Harness UI is compiled into **runner image**. “Frontend-only” HyperAgents native UI change still needs one runner image build; outer HIVE Worker/frontend, Core, and Control Plane stay untouched. Build once from a clean, pushed exact SHA, ideally on production `linux/amd64` host with existing BuildKit cache. Never copy dirty worktree files into release build.

1. Finish PDF fix on new branch; run focused tests and relevant build/type checks. Commit and push. Record full SHA. Clone/fetch that exact SHA on build host.
2. Build immutable runner image and verify its shipped profile:

   ```sh
   SHA="$(git rev-parse HEAD)"
   TAG="hivemind/harness-chat:sha-$(git rev-parse --short=10 HEAD)"
   docker buildx build --platform linux/amd64 --progress=plain --load \
     --build-arg "DSH_CLIENT_COMMIT_HASH=$SHA" \
     -f deploy/hivemind-chat/Dockerfile -t "$TAG" .
   ./deploy/hivemind-chat/verify-image.sh "$TAG"
   docker image inspect "$TAG" --format '{{.Id}}'
   ```

3. On server, save currently live image identity and existing versioned Compose chain. The chain is recorded in `hivemind-harness-runner-1` label `com.docker.compose.project.config_files`; use all listed files in order, plus an **image-only** override pointing to new immutable tag/digest. Do not use generic Compose alone. Use `/root/hivemind/.env` without printing its contents, project `hivemind`, and `--profile harness-chat`.
4. Before replacement, compare normalized `docker compose config --format json` for existing and candidate chains, deleting only `.services["harness-runner"].image` before hashing. Hashes must match. Also confirm candidate image verifier and rollback image remain available. If any non-image config differs, stop and inspect.
5. Replace only runner:

   ```sh
   docker compose --env-file /root/hivemind/.env -p hivemind \
     --profile harness-chat \
     -f <each-live-versioned-manifest-in-order> -f <candidate-image-only-override> \
     up -d --no-deps harness-runner
   ```

   Do **not** use `--remove-orphans`, `down`, or rebuild/restart Core, Control Plane, HIVE Worker, or database. Recreate `harness-tunnel` only if the versioned release path explicitly requires it; do not alter its config.
6. Verify runner health, image ID/revision, restart count, tunnel, and bounded error logs. In authenticated production UI, test new HyperAgents session, agent picker/avatar, plan/inline employee, artifact PDF render, right Preview, download, direct session reload, and a HIVE-MIND chat regression. PDF canary must show one terminal render receipt, visible PDF, and working download. Do not call build/image verification “live success.”
7. If any canary fails, immediately reapply saved rollback image-only override with same manifest chain and `up -d --no-deps harness-runner`, then recheck health/restarts and prior chat. Keep failed candidate tag for diagnosis.

## Useful checks

```sh
ssh singulance 'docker inspect hivemind-harness-runner-1 --format "image={{.Config.Image}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}}"'
ssh singulance 'docker inspect hivemind-harness-tunnel-1 --format "status={{.State.Status}} restarts={{.RestartCount}}"'
ssh singulance 'docker inspect hivemind-harness-runner-1 --format "{{index .Config.Labels \"com.docker.compose.project.config_files\"}}"'
```

Release is complete only after authenticated browser canary passes and exact live image digest is recorded. Production single-runner replacement can briefly reconnect active users. No zero-downtime promise without blue/green routing.
