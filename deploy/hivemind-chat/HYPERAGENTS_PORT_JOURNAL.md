# HyperAgents runner port journal

- Base: production `hivemind-chat` Harness composition. Core, frontend, and generic agent loop remain unchanged.
- Stage A (`0f7f5408bb`): port operating, research, browser, artifact, skill, employee-directory, UI, and typed session-event packages without activating new preset behavior. Deploy before Stage B so rollback can read new event types.
- Stage B (`68a0c7d08f`): activate operating context, playbooks, plan, inline workstreams, progressive capabilities, and activity UI in `hivemind-hyperagents`.
- Stage C (`dd63333bad`): switch research to tenant-scoped HIVE jobs and cover web-research tools with native approval; align MCP dependency versions for Linux builds.
- Research: use tenant-scoped HIVE web jobs through the existing control-plane proxy; production runner has no direct DeepSeek or Parallel search key. Native web approval remains required.
- Browser: production Playwright MCP exists, but runner needs its existing service credential and internal URL passed as runner-only environment. Never bake credentials into image or prompt.
- Acceptance gate: exact-SHA Linux image, image verifier, old-chat regression, authenticated operating-plan/research/browser/artifact/connected-action canaries, session reload, and saved rollback image. Source tests alone do not prove release.
- No production container has been changed by this port until all gates pass.
- 2026-09-29: `9c3b892b01` fixed duplicate `hivemind_capabilities` and browser-header config. Targeted 53 tests, host typecheck, image verifier, and isolated preset mount passed. Runner-only production canary switched to HyperAgents without mount error.
- Production company-strategy canary still failed operating quality: model skipped `hivemind_operating_context`/`hivemind_operating_plan`, used research then screenshot-only browser captures for source claims, and returned directional claims without first-party verification. Immediately restored healthy compatibility image `compat-6a2fe73a86` (zero restarts). Advanced HyperAgents is not accepted/live.
- Next gate: prove substantive company task enters operating context/plan and produces cited first-party evidence before reattempting runner-only release. Current production default model is GLM 5.3 Flash; local HyperAgents canary used a different model, so compare behavior on same model before attributing the gap to preset code.
