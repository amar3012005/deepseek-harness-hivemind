# @deepseek-ai/dsh-hivemind-progressive-skills

Provides HyperAgents with progressive access to the complete scoped Harness skill registry without publishing every skill name and description into each model request.

`hivemind_skills` has two operations. `search` accepts the complete specialized capability or output need and returns a bounded list of matching names and descriptions. `load` resolves one exact returned name and exposes its complete instructions and resource location through the normal retained tool result.

The provider registry and filesystem discovery remain unchanged, so the available capabilities are not reduced. Only the HyperAgents model-facing consumer changes; Standard and other presets continue using the native full-catalog `skill` consumer.

## Verification

Run `pnpm exec vitest run packages/hivemind/progressive-skills/tests/progressive-skills.spec.ts` and `pnpm run verify-cordis-config -- --preset hyperagents`.
