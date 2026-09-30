# HyperAgents continuity release — 2026-09-30

## Deployed artifacts

| Service | Exact source | Image |
| --- | --- | --- |
| harness-runner | `15f83836ea379d0c7f6b06843309746f6f1e00a6` | `hivemind/harness-chat:sha-15f83836ea` |
| Control narrow signed task-record endpoint | `acba4dae521cc16f7b304f5321b8fbccaa10f566` | `hivemind/control-plane:sha-acba4dae` |

Core and outer frontend were unchanged. Cutovers used the live versioned Compose chain, image-only overrides and `up -d --no-deps`; sibling container IDs remained unchanged. All three services were healthy with zero restarts after verification.

## Behavior

The chosen employee owns the session persistently; the picker locks after the first turn. The native owner projection survives reload and chat pagination. Completed responses automatically create private `hyper-agents` records with kind `task_status`, owner, timestamps and receipt references. Durable outbox retries and deterministic keys prevent duplicate records. `completionScope: response` records response completion, not proof that external actions succeeded. Company HIVEMIND memory retains its separate tools and approval rules. Swarm remains deferred.

## Verification

- 100 focused runtime, context and client tests passed; host/client TypeScript builds and repository pre-push typecheck passed.
- Three focused Control tests passed, including signed validation and two-tenant isolation. This is not a claim that the entire platform suite passed.
- Live authenticated session: `session-eb92d976-6dcd-4292-b3cd-7845b7c0138a`.
- Elena Kovács (`elena-kov-cs`) completed a fictional blueprint without a model save call. Automatic private memory: `a682970c-b465-4d76-8527-92e80fde5859`, completed at `2026-09-30T19:10:27.103Z`.
- Reload retained Elena and disabled reassignment. A second turn recalled that exact record using `hyperagents_memory`, with no company-memory call.
- Second automatic record: `da8ff158-1035-4549-8ed4-f92542092b92`. Database verification found exactly one record per completed turn, both attributed to Elena.

## Rollback

Server manifests preserve the prior live chain and image-only rollback:

- `/root/releases/manifests/hyperagents/agent-continuity-15f83836ea/rollback-image-only.yml`: runner `hivemind/harness-chat:sha-b5884517c2`.
- `/root/releases/manifests/hyperagents/dsh-task-memory-control-acba4dae/rollback-image-only.yml`: Control `hivemind/control-plane:sha-fb118fb7`.

Use the saved chain and replace only the affected service with `--no-deps`. Documentation commits after the deployed source SHA do not require rebuilding these images.
