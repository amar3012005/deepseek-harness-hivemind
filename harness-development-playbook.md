# HIVE-MIND Harness development playbook

Use this with [harness-fe-guide.md](harness-fe-guide.md), which maps the owning frontend files. This playbook records the current fast path for our multi-tenant BRAIN and HyperAgents modes. Check the exact checkout and active production image before any release; an old handoff's image tag is historical evidence, not a deployment target.

## Pick the smallest owner

| Change | Start at | Release unit |
| --- | --- | --- |
| Native chat, composer, session rail, Environment, Preview | `packages/client/ui-conversation`, `ui-workspace`, `ui-layout`, `ui-hivemind-connect` | Harness runner image |
| Schedule UI and task details | `packages/client/ui-schedule` | Harness runner image |
| Schedule persistence, dispatch, cold session wake | `packages/hivemind/schedule-postgres`, `packages/schedule` | Harness runner image; database migration only when schema changes |
| Tenant-aware session list and mode | `packages/session/session-persistence-postgres`, `packages/api/session-controller`, `packages/client/ui-hivemind-connect/src/client/session-route.ts` | Harness runner image |
| Outer HIVE navigation or VOICE page | Parent HIVE-MIND frontend | Its own frontend release |

Follow an event from durable storage through API to client before editing a visual symptom. For cold sessions, the creation header may still say `hivemind-chat` after the user selected `hivemind-hyperagents`; resolve the latest persisted preset event inside tenant scope. Filter BRAIN and HyperAgents rails from that effective preset, including direct URL reloads and blank sessions. Tenant queries must carry the authenticated organization, user and session scope; never restore a due Schedule task by session ID alone.

## Fast local loop

1. Read the one row in [harness-fe-guide.md](harness-fe-guide.md) for the component, plus its package README. Read [architecture](docs/architecture.md) when changing plugin services or events; use [Cordis primer](docs/cordis-primer.md) when composition is unclear.
2. Run the native web profile from source with the HIVE bundle patch: `pnpm dsh web --patch packages/bundle/hivemind-web-app/cordis.patch.yml`. Inspect the effective tree with `pnpm dsh --profile web --dump-config` when a row does not mount.
3. The base bundle already contains `id: hmr`, disabled by default, with `@deepseek-ai/cordis-plugin-hmr`, and provides `id: timer`. A development overlay can enable that existing HMR row; keep a console logger exporter so reload diagnostics are visible. Stable `id`s let Cordis distinguish an edit from remove plus add. The web profile's live patch reload watches configuration even when module HMR is disabled. UI bundler reload and Cordis plugin HMR are different mechanisms; neither changes a production image.
4. If a plugin is silent, inspect its fiber state. `PENDING` commonly means an unmet `inject` service; invalid Schemastery `Config` should fail at load. Plugin registrations must be reversible effects so HMR unload does not leave old handlers behind. Use [composition and HMR](docs/cordis-tutorial/06-composition-and-hmr.md), [configuration](docs/cordis-tutorial/05-config.md), and [tool authoring](docs/cookbook/adding-a-tool.md) for the exact APIs.
5. Run the focused test for the changed owner and its TypeScript face. Build once before packaging; use the repo's pre-push checks. Do not rerun the full suite for a CSS or route-only edit unless its dependency graph requires it.

For a new capability, prefer a plugin and an explicit `Config` schema over an agent-loop edit. `defineTool` owns validated tool inputs and canonical output; the UI card projects persisted call/result data. Keep model-visible state replayable from session events. A setting that differs by tenant or deployment belongs in a validated config or tenant-scoped record, not a fixed source constant.

## Why a production UI edit still builds a runner

`deploy/hivemind-chat/Dockerfile` copies the repository, installs workspaces, and runs `pnpm run build`. Native UI, backend plugins, and the HIVE bundle ship together in `harness-runner`. BuildKit's pnpm store and unchanged Docker layers help, but `COPY . .` precedes install/build, so any source SHA can invalidate both steps. HMR is for local iteration; it cannot replace the immutable production image. A faster Dockerfile would need a separate reviewed packaging change, not an improvised live volume mount.

The release sequence is: push an exact Harness SHA → build one cached `linux/amd64` image → run `deploy/hivemind-chat/verify-image.sh` and check its revision label → compare the live versioned Compose chain to an image-only override → recreate only `harness-runner` with `--profile harness-chat up -d --no-deps harness-runner` → verify health and the authenticated changed route. Keep the previous image as rollback. The live Compose file list is recorded in the runner container's `com.docker.compose.project.config_files` label; preserve its order and `/root/hivemind/.env` without printing secrets. A normalized Compose comparison should differ only at `services.harness-runner.image`.

For the parent platform, follow its `.hivemind` release owner: the Ops Gateway is preferred when available; a direct runner-only Compose release is appropriate when explicitly requested and the current manifest chain, exact image, and rollback are verified. Core, Control Plane, outer frontend, and database are separate release units. Do not rebuild them for a native chat change.

## Acceptance and cleanup

Check both authenticated modes after a native UI change: new and old session, direct reload, correct preset, timestamped mode-specific history, composer position, Schedule control, and Preview/Environment when affected. For Schedule changes also prove tenant isolation and cold wake with focused integration coverage. A healthy container alone does not prove the browser received the new bundle.

Record source SHA, image ID, live revision, health, canary result, and rollback image. After success remove only unused historical `hivemind/harness-chat` tags, preserving the live image and one working rollback; an image referenced by any container must remain. Avoid global Docker prune because it can affect other services.

## Fast frontend release skill

For compatible incremental runner images and UI proof, read [harness-fe-deploy](skills/harness-fe-deploy/SKILL.md).
