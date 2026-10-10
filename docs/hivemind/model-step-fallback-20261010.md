# Native model-step fallback

## Verified provider

The existing protected host `llm-pi-ai/openai-codex` OAuth grant completed real text and tool requests through the native `openai-codex-responses` provider. GPT-6 Luna returned `READY` in 1,174 ms; its complete harmless `read_fixture` call/result roundtrip returned `FIXTURE_READY` in 2,473 ms. The bundled catalog lacks GPT-6 Luna, but an explicit model entry is accepted by actual native profile resolution and retains provider-owned OAuth. The evidence file is `evidence/codex-fallback-canary-20261010.json`. These measurements verify protocol/account access; they are not latency guarantees or production recovery proof.

GPT-5.6 Luna also worked. GPT-5.4 Mini was listed but rejected by this account. Direct OpenAI API had no configured key; the independent Groq account returned `organization_delinquent`. Switching models under the same exhausted OpenRouter account is not independent fallback.

## Native recovery

`llm-retry` accepts an optional `fallback` route. Default behavior is unchanged. The native `agent/request-error` waterfall schedules one immediate retry of the **same model step**, ahead of normal primary backoff, for normalized QUOTA, RATE_LIMIT, SERVER, NETWORK, TRANSPORT, TIMEOUT and EMPTY_RESPONSE errors. Authentication, invalid requests/tool formats, context overflow and missing credentials retain their own owners. Failed fallback attempts do not recursively fallback.

The required non-surface `llm/fallback` event stores the failed step and original call configuration. A native session projection recovers this checkpoint after cold restoration. `agent/request` selects the independent route for that step and restores primary on the next step/turn. An explicit native `model/selection` clears recovery ownership. No agent options, selected model, tool permission or user input is mutated. Successful prior tools remain saved; failed partial tool calls never execute, and failed assistant attempts are absent from model-facing history. The existing native request durability barrier persists the route record before dispatch.

pi-ai discards original structured HTTP exceptions, so its adapter boundary normalizes HTTP 402 and the exact OpenRouter reservation/credit codes to QUOTA. Recovery itself routes on stable failure code, not arbitrary message text.

## Managed activation

Preserve all existing native provider rows; update via native settings RPC `settings.update('llm-pi-ai', patch, currentRevision)`. Exact verified added row:

```yaml
providers:
  openai-codex:
    models:
      - id: gpt-6-luna
        name: GPT-6 Luna
        contextWindow: 1050000
        maxTokens: 8192
        input: [text, image]
        reasoningEfforts: {off: null, low: low, medium: medium, high: high}
```

Do not override `api`, `apiKeyEnv` or `baseURL`: catalog-owned OAuth and Responses must remain intact. This configuration can activate primary GPT-6 Luna without new source. Set selected/default company model through native session/default-model owners, preserving authenticated source and saved work. The shared platform grant is explicitly authorized by the user; no personal per-user ChatGPT plan adapter was enabled.

For remaining OpenRouter-primary steps, configure the existing company-scoped native retry mount:

```yaml
llm-retry:
  fallback:
    fromProvider: cloudflare-openrouter-streaming
    provider: openai-codex
    model: gpt-6-luna
```

Do not configure exhausted OpenRouter as a claimed independent reverse fallback. Leave the old HIVE `requestFallbackProvider`/`requestFallbackModel` settings off: that older helper is not this durable bounded recovery policy.

## Build / rollback / remaining production proof

Compile and bundle `llm-retry`, `llm-pi-ai`, and `session` (generated known-event catalog). No frontend, Core, Control, credentials, migrations or loop patch is needed. Preserve the immutable base source, native shared presets, compaction, memory limits, security, voice and pending work. The catalog was regenerated from declarations.

Focused checks: 226 tests across native retry/persistence and pi-ai config/conversion/HTTP adapter; owner TypeScript compilation passed. Tests verify budget failure after saved tool work, one fallback, next-step/turn primary restoration, failed partial text/tool handling, cold route checkpoint reconstruction, disabled policy, isolated sessions and permanent failures. A native real Codex tool roundtrip verifies the independent protocol.

Root owns cutover. Before marking complete, root must verify an authorized organization canary through deployed native adapter and saved task continuation, and a deliberately bounded failed-primary attempt recovered through the configured native policy with each tool executed once. Text/tool standalone compatibility does not satisfy that production proof.

Rollback: disable the fallback policy on the same event-aware binary; subsequent steps return to saved primary. **Do not downgrade to a binary that does not recognize required `llm/fallback` events** in sessions that used fallback. It must retain the generated catalog/event support, otherwise persistence correctly refuses the unknown required event. Credential and selected primary configuration rollback use their existing native owners.


## Final route policy and minimal reasoning

User authorized Codex GPT-6 Luna primary, with Cloudflare/OpenRouter GPT-6 Luna independent fallback. Configure `llm-retry.fallback` as an array:

```yaml
fallback:
  - fromProvider: openai-codex
    provider: cloudflare-openrouter-streaming
    model: openai/gpt-6-luna
    maxTokens: 8192
  - fromProvider: cloudflare-openrouter-streaming
    provider: openai-codex
    model: gpt-6-luna
    maxTokens: 8192
```

One durable switch per model step prevents ping-pong even when both providers fail. Per-route output cap never increases the primary request cap. No retry for invalid request/auth/context failures.

Set the native Codex model `reasoningEfforts.off: 'none'`, provider profile `reasoning: 'off'`, agent-default-model `reasoningEffort: 'off'`, and each saved room's native reasoning selection off after the new adapter is live. The Codex payload hook explicitly sends `reasoning: {effort: none}` only for this declared mapping, and preserves `strict: false` for optional function arguments. Other providers and off:null mappings are unchanged. Native standalone exact-model none tool roundtrip passed in2542ms; local actual adapter wire regression confirms none plus non-strict tools. Production none activation and fallback recovery still require root's final release proof.

Root's independent gateway tool-result roundtrip passed in3013ms with output cap8192/low. It does not establish provider uptime beyond the probe. Keep the managed gateway model cap8192 too. Source baseline fallback commit60a1727637ed5ce7b9de190b25ad8b89d732e800 passed the normal full host/client pre-push checks.
