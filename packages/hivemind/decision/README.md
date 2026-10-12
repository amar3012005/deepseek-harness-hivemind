# Native decision layer

A host-side Cordis service for choosing among explicit options and evaluating yes/no or ordered-rubric questions. It does not run actions, grant permissions, replace the agent loop, or change existing model routing. Model inference is disabled until a provider is explicitly configured.

## Native feature map

| Stage | Existing DSH feature reused | New seam |
| --- | --- | --- |
| Lifecycle | Cordis `Service` registration, dependency injection, scoped disposal | `ctx.hivemindDecision` |
| Identity | `ctx.hivemindIdentity.resolve(signal)` | Resolve on every operation before inference |
| Secrets | `ctx.credentials.resolve(credentialRef(name))` | Resolve references per call; never put secrets in tool input/results |
| Transport | Native LLM attribution headers | Dedicated alpha Decisions HTTP adapter |
| Inputs/results | Existing Zod and TypeScript contract conventions | Choice, Noul, Score validation and distribution checks |
| Cancellation | Native abort signals | Three-second bounded decision deadline, configurable 10ms–10s |
| Consumer | Native model routing, attention, delegation services remain owners | Call this service before choosing a configured route/action |

The inspected DSH docs revision is `639ed015397290b3745d163aafe02ffee4aa3f84`. `subsystems/llm-streaming.md` documents `GenerateOptions`/`StreamChunk` for text/tool streams. That protocol does **not** represent the non-generative Decisions API, so this plugin deliberately does not register Mercury Decide as a chat adapter or call `llm.stream` recursively. Existing conversation models remain unchanged.

## Configure

```ts
import { createOpenRouterDecisionPlugin } from '@deepseek-ai/dsh-hivemind-decision'

await ctx.plugin(createOpenRouterDecisionPlugin({
  enabled: true,
  // Provision a Cloudflare custom provider with base_url https://openrouter.ai.
  // Confirm a real request on this exact path before enabling a consumer.
  endpoint: 'https://gateway.ai.cloudflare.com/v1/ACCOUNT/GATEWAY/custom-openrouter-decisions/api/alpha/decisions',
  apiKeyRef: 'OPENROUTER_API_KEY',
  gatewayTokenRef: 'CLOUDFLARE_API_KEY',
  timeoutMs: 3000,
}))
```

Both credentials are server-owned references through the existing native credentials service, not copied into new storage. With a compatible configured gateway BYOK store, `apiKeyRef` can be omitted and `gatewayByokAlias` supplied alongside `gatewayTokenRef`; that gateway combination must be proved separately. No gateway configuration or secret lookup has been performed by this feature.

Cloudflare's ordinary OpenRouter page documents chat-completions paths, not alpha Decisions. Its **custom-provider endpoint** documents arbitrary upstream path forwarding. The exact decision path is therefore configurable and remains unproven against the live gateway. The direct provider endpoint is `https://openrouter.ai/api/alpha/decisions`; use it only with an intentionally configured provider key. There is no automatic direct-provider bypass.

## Choice helper

```ts
const result = await ctx.hivemindDecision.decide({
  input: 'Hi',
  context: 'No pending company decision is needed for this greeting.',
  systemPrompt: 'Choose the least expensive eligible route sufficient for this request.',
  mode: 'model',
  choices: [
    { id: 'fast', description: 'Greetings and straightforward answers.' },
    { id: 'deep', description: 'Multi-step analysis or complex planning.' },
  ],
}, signal)
if (result.ok) {
  // Map choiceId to a host-owned allowlist. Apply authority/capability/budget checks here.
  // Optionally require a minimum confidence; low confidence is not permission to act.
}
```

`mode: 'policy'` (the default) chooses the highest configured priority, using input order to break ties, without inference. It does not interpret the input or claim probabilistic confidence. Ineligible candidates are excluded. One eligible choice can also be resolved without inference. Provider failure returns a typed failure; callers own any explicit fallback policy. There are no retries, hidden asks, or automatic actions.

## General primitives

`evaluate({state, questions}, signal)` accepts a JSON string/object/array as state and keyed `noul`, `choice`, or `score` questions. Instructions and criteria are deliberately restricted to text in this first version, a subset of the upstream JSON-capable schema. Limits: 32 questions, 32 Choice options, 2–10 Score levels, 64KiB total request, 128KiB response. Choice and Score responses require normalized probability distributions; malformed/missing statistics fail explicitly. Scores must agree with their distribution. No generated rationale or fabricated confidence is added to provider output.

The provider sends `{model: 'inception/mercury-decide', state, questions}` directly. `decisionsRequest` is an SDK argument wrapper, not a wire-body wrapper. Fixed endpoint/model prevent recursive route selection. It sets no-cache/no-body-log gateway headers and refuses redirects; application code logs neither input nor credentials.

## Integration order

1. Register the service alongside the authenticated identity/credential services.
2. Provision and verify the exact Cloudflare custom-provider route using a fictional scope.
3. Test ordinary/simple, complex, ambiguous, failed and canceled decisions on real inference.
4. Add one consumer (model routing or attention) in shadow mode and compare against current behavior.
5. Activate that consumer only after latency, quality and fallback behavior are measured.

Use the authenticated scoped service for the requesting tenant. Callers must retrieve authorized context and candidate capabilities before invoking it; the decision model never determines access. No cross-tenant cache/state is held. This is a native host API, not an unauthenticated public HTTP endpoint. If a remote API/tool is later exposed, derive identity from native authenticated execution scope and validate scope before passing context.

## Sources

- [OpenRouter Mercury Decide](https://openrouter.ai/inception/mercury-decide)
- [Official SDK request types](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionsrequest.ts)
- [Official SDK HTTP operation](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/funcs/alphaDecisionsCreate.ts)
- [TypeSafe API contract](https://docs.typesafe.ai/api)
- [TypeSafe workflow guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one) (web reader could not retrieve this page; API contract used instead)
- [Cloudflare custom-provider paths](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [Cloudflare OpenRouter integration](https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/)

## Verification

Focused native Cordis identity injection, explicit policy/model behavior, unauthorized/disabled/malformed requests, typed primitives, deadline/cancellation, HTTP request-body and private gateway headers are covered by `tests/decision.host.spec.ts`. These are fixture tests, not evidence of live Mercury inference or gateway compatibility.

## Runtime attention integration

The web bundle registers the generic service through explicitly enabled provider composition. `HIVEMIND_DECISION_ENABLED=1`, an exact `HIVEMIND_DECISION_ENDPOINT`, and credential reference names are required for inference. Attention policy lives in HQ Runtime's `attention-policy.ts`, not this generic package. Model failure never routes directly around the configured endpoint.

The authenticated native assessment reloads persisted event identity, current source consent, saved attention settings and Runtime snapshot. Source/type exclusions are deterministic; topical decisions occur after assessment. Core only persists the native decision and invokes native delivery. Notify admits a non-waking next-turn message; wake requests a waking next turn. Both create the existing deduplicated workspace notification. UI pending/consumed presentation is a separately integrated frontend change.

`tests/evidence/mercury-direct-fictional-20261010.jsonl` records actual Mercury inference through native service/credentials and an authenticated localhost HTTP endpoint called with curl. Fictional cases returned retain, notify and wake recommendations. These tests did not admit production inbox items, start work or create notifications. The gateway evidence file records typed three-second timeouts on the separately tested existing gateway route; direct inference success does not prove that route.

Build isolated canary modules with `tsdown -c scripts/canary/native-decision-build.mjs`; run `scripts/canary/native-decision-http.mjs` in an isolated compatible runner with module paths, explicit endpoint, server-owned credential reference, and optional gateway token reference. `DECISION_CANARY_SERVER=1` exposes only the fictional scenario endpoint on port 18086; bind/publish it to localhost and supply an ephemeral `DECISION_CANARY_TOKEN`. No tenant data, memory writes, agent delivery or outreach is performed. The disabled-activity scenario skips inference. Credential values must remain in private temporary environment files, never in command output or committed artifacts.
