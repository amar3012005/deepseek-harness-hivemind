# Authenticated Codex provider API

English | [中文](2026-10-08-codex-provider-api.zh.md)

A disabled-by-default HTTP facade exposes text, web search, image generation and native live voice through one server-owned account. A Cloudflare Worker holds a separate public key and forwards a dedicated internal key. Neither key exposes the underlying Codex grant.

Every invocation revalidates the configured company/user membership. Image requests resolve an owned native session and use the existing agent-scoped GenerationRegistry provider, durable operation identity and recovery state. Reusing an image identity with changed input is rejected. Text/search use the existing refreshable Codex authorization; arbitrary tool execution is not exposed. Live voice preserves the native session, SDP and call lifetime protocol; it is not a speech-synthesis endpoint.

The provider is opt-in through managed runner environment references. It does not change the default reasoning model or frontend. The Worker accepts only fixed HTTPS upstream routes, bounded JSON and bearer authorization. Requests and secrets are not logged. Two concurrent text/image requests are allowed; disconnected requests are cancelled.

Compilation and a Worker dry build passed. Production activation and actual capability canaries remain separate evidence; source presence is not a live-provider claim.
