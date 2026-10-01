# Agent Note: Native OpenAI search with authenticated HIVE fallback

Status: implemented

## Problem

HIVE agents need a shared subscription-backed search provider without connector discovery or a second OAuth store. The existing HIVE web-job path must remain available when auxiliary search cannot complete.

## Decision

The HIVE web profile includes `web-search-openai` disabled, with existing search routing preserved until the user requests activation. Activation enables the plugin, selects `openai-responses` in `ctx.web`, and enables `nativeWebSearch` on the intended presets. Codex transport resolves the existing `llm-pi-ai/openai-codex` grant through the same pi-ai credential adapter used by the Harness LLM plugin. That adapter owns serialized refresh and atomic persistence. Public Responses transport uses a distinct externally maintained credential reference.

The authenticated `hivemind_web_search` tool performs native search first and returns to its existing tenant-scoped web-job service on provider failure. HIVE authority and approvals remain in that tool. A global provider never captures a tenant's authority. Cancellation stops execution; it is not a fallback signal. Completed native search output is normalized into bounded cited sources, with exact auxiliary input and route receipts recorded in Session events.

## Alternatives considered

**A second SIWC credential file.** This duplicates the existing subscription-login store and does not match the user's supplied Prime Agent authentication workflow.

**A global provider closing over one HIVE tenant.** This makes fallback convenient but could route other tenants through the first tenant's credentials. The authenticated tool therefore owns the Core fallback.

**Replace the conversation-model adapter or search before every reply.** Neither is necessary for a provider plugin; both introduce cost and change unrelated conversation behavior.

## Consequences

The shared HIVE profile owns provider selection, while each HIVE request keeps its authority and permission checks. Generic native callers use the provider but lack the tenant web-job fallback. A provider deadline or an interrupted stream produces no partial successful result. Credentials remain deployment-owned; activation depends on an authorized grant in the production runner's credential store. Focused TypeScript compilation establishes build compatibility; it does not establish live account entitlement or production behavior.
