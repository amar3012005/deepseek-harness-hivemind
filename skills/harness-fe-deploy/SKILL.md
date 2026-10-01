---
name: harness-fe-deploy
description: Build and release native DeepSeek Harness frontend packages for HIVEMIND using a compatible immutable runner base, focused compilation, and runner-only production cutover. Use for native Harness UI releases; outer Da-vinci navigation uses its separate Worker release.
---

# Fast Harness frontend deployment

Start with `harness-fe-guide.md` and the owning component. Use `harness-development-playbook.md` for this checkout's release commands.

## Select the build path

- Native client packages are loaded through the Harness boot graph. Recompile their **client face**; updating the outer website does not update them.
- Outer Da-vinci routes, sidebar, or API proxy changes require a separate Worker release and parent gitlink promotion.
- Use Cordis HMR locally. Production receives an immutable image, never copied files in a running container.
- Incremental images are suitable when the installed base contains compatible dependencies and the full source diff can be accounted for. Changes to dependencies, lockfile, toolchain, static web shell, or package wiring require the corresponding wider build.

## Reuse the installed image safely

1. Finish source edits, focused tests, and commit/push. Wait for the push hook to finish before another commit/push; concurrent pushes can race remote refs and builds.
2. Record the live runner image, digest, architecture and source revision. Choose a compatible immutable base and retain the current image for rollback.
3. Fetch the exact pushed SHA into a clean detached builder worktree. Assert HEAD and clean status. Build on the production target architecture, currently linux/amd64.
4. Compute **all changes from the base revision to the target SHA**, not only the last commit. Allow only explicitly reviewed package paths. Handle deletions explicitly or use the full build path; a copy-only overlay cannot apply deletions.
5. Copy that complete source delta into an isolated Docker context. Write provenance containing source SHA, base SHA/digest, changed paths and rebuilt packages.
6. Use the base image as `FROM`, set `DSH_CLIENT_COMMIT_HASH` to the target SHA, and compile the affected graph. In this repository:

   ```sh
   node ./node_modules/typescript/bin/tsc -b packages/client/<package>/tsconfig.json
   cd packages/client/<package>
   node ../../../node_modules/tsdown/dist/run.mjs --env.DSH_BUILD_FACE client --config tsdown.config.ts
   ```

   Rebuild each changed client package. Rebuild the host face for changed server packages. A newly persisted Session event also requires the generated known-event catalog and rebuilt Session host; otherwise cold restoration can reject it.
7. Tag `hivemind/harness-chat:sha-<short-sha>`, apply the full revision label, and assert the resulting architecture and label. The image must contain compiled client assets, not just TypeScript source.
8. Run `deploy/hivemind-chat/verify-image.sh <image>` before cutover.

## Targeted production cutover

Prefer the available Ops Gateway Harness deployment tool. If unavailable, use the existing versioned production release helper with the complete managed Compose chain. During the verified releases this was `/root/releases/hq-production-cutover.py`; inspect its current argument contract before using it. It receives the expected live image, target image and exact source SHA, records rollback, and checks service health plus unchanged sibling identities.

Recreate only the runner with its existing secrets, volumes, networks and ingress. Preserve authentication and tenant checks. Never substitute a simplified container definition. Keep bootstrap and session APIs out of static-asset caching/routing.

## User-facing verification

- Open a fresh authenticated production page and reload its direct route. Check the real boot graph and changed UI; HTTP 200 and container health alone do not establish success.
- Inspect desktop geometry with the actual transcript. Fixed header utilities need a reserved row; permanently visible activity needs a reserved side column. Open editors in their own flow so they do not cover their toggle. Test narrow layouts when changing geometry.
- Verify history starts collapsed when required, clicks expand/close, goal editing works, and settings remain tenant scoped. Do not change the user's enabled state just to capture proof.
- Capture a screenshot and record source SHA, image digest, health, route result and rollback identity. Roll back if the changed route fails.

## Keep iterations fast

Batch one coherent UI edit before the release hook. This checkout's pre-push host build and client typecheck took about 50–60 seconds; the validated incremental image build took about 20 seconds. These are observations, not promised timings. Reuse BuildKit and installed dependencies rather than rebuilding unrelated services. Do not bypass hooks or treat cached bundles as evidence that a release contains the change.

Never print credentials, cookies, admission tickets or token-bearing bootstrap logs. Keep the current image and one compatible rollback; remove only specifically identified unused artifacts when cleanup is authorized.
