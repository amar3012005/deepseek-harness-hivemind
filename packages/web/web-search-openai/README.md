# @deepseek-ai/dsh-web-search-openai

Native Cordis provider for `ctx.web`, registered as `openai-responses`. The HIVE web profile selects it globally; neither users nor agents configure a connected app. The owning subsystem is [Web](../../../docs/subsystems/web.md).

## Configuration

| Setting | Default | Contract |
|---|---|---|
| `transport` | `codex` | Existing Codex subscription grant, or `responses` for a separately authorized public Responses token. |
| `model` | `gpt-6-luna` | Auxiliary search model supported by the account. |
| `timeoutMs` | `12000` | Entire primary operation, including credential lookup; range 1000–30000 ms. |
| `accessTokenEnv` | `OPENAI_SEARCH_ACCESS_TOKEN` | Credential reference used only with `responses`; resolve it dynamically on each request. |

Codex authentication uses the same native `llm-pi-ai/openai-codex` grant and pi-ai refresh path as Prime Agent. The Harness credential provider owns atomic persistence and serializes rotating-token updates. Its existing authorization flow offers browser or device login. Do not place tokens in profile YAML, source code, images, sessions, or browser responses. Public Responses tokens and Codex subscription tokens are distinct; changing transport does not convert a credential.

Codex searches use the catalog transport base `https://chatgpt.com/backend-api/codex`; public Responses uses `https://api.openai.com/v1`. Both send a fresh, stateless search with `store: false`, streamed output, and only native `web_search`. No memory, connector payload, conversation history, or customer authentication token is forwarded. Only the explicit query is sent. Credential-bearing search requests reject redirects and do not automatically retry.

## HIVE composition and fallback

`hivemind_web_search` retains its existing identity and permission policy. With `nativeWebSearch: true`, it calls the selected native provider first. Missing authorization, upstream errors, incomplete streams, empty results, or the primary deadline return control to the existing tenant-authenticated web-job service. This preserves that service's configured search backend rather than replacing it. User cancellation never starts fallback. The primary deadline leaves time inside the tool's existing 60-second budget for the fallback job.

Native `web_search` also uses this provider through `ctx.web`; its consumer reports provider errors normally. The tenant web-job fallback belongs to `hivemind_web_search`, because it requires authenticated HIVE authority and cannot be captured by a global provider. HyperAgent remote research jobs retain their existing durable job contract.

Only a completed response containing a completed web-search call and real source URLs is published. Sources come from native citations and consulted URLs, never model-written JSON. Cited URLs precede other consulted URLs, are deduplicated, and respect the requested limit. `content` is capped at 12000 characters. Consumers should render source URLs as clickable citations.

A secret-free `web/openai-search-request` Session event records exact auxiliary model input. `hivemind/web-search-route` records whether native search or the existing service was chosen. No authorization token or raw upstream error is persisted.

## Model Experience

### Auxiliary search request

#### What the model sees

One user query, a stable concise instruction, and one native web-search tool. This model is separate from the conversation model and must not follow instructions in retrieved pages.

#### Token effect

Search incurs one auxiliary model operation when requested. Low search context and a concise answer reduce provider and conversation tokens. No search is forced before unrelated conversation replies.

#### KV Cache effect

The instruction and tool definition are stable. Queries vary; no previous-response or conversation state is shared between searches or tenants.

### Conversation result

#### What the model sees

Bounded source URLs, titles, optional snippets and dates, and an optional concise search summary. The tool retains its existing result envelope and permission policy.

#### Token effect

At most the requested source count and the bounded summary enter conversation context. Provider failure moves to the existing search service without an extra conversation-model repair turn.

#### KV Cache effect

Provider selection adds no persistent prompt block or additional tool schema.

## Known Limitations and Deferred Work

Account/model access and native web-search entitlement require successful authorization on the runner. A saved grant on a developer's machine is not proof that production has it. The plugin does not redistribute credentials or turn a personal subscription into customer entitlements. Public Responses access-token refresh is owned by the external credential issuer. Native direct callers do not receive the tenant web-job fallback; that belongs to the authenticated HIVE tool.

The package has no `./invariant` export: it introduces no independently persisted projection to reconcile. Session requests and results use their existing durable owners.
