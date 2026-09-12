# Agent Note: Exact connected-app status and OAuth return

Status: implemented

English | [中文](2026-09-12-exact-connected-app-status-and-oauth-return.zh.md)

## Problem

A pure connection-status request was routed through semantic tool search. Search is correct for app work, but it may select a different toolkit capable of the described operation. As a result, an explicit Instagram status check could offer a ScrapeCreators connection. Authorization also required a manual return-and-continue action even when the provider had already redirected successfully.

## Decision

The HIVE connected-app bridge now has an app-neutral `connection_status` action. It resolves an explicitly named app against the authenticated Composio session's toolkit metadata and accepts only one exact normalized slug or name match. Real app work continues to use full `COMPOSIO_SEARCH_TOOLS` discovery; no provider or app-specific routing rule was introduced.

Composio sessions are isolated per HIVE conversation while retaining the stable authenticated user as connection owner. When configured, their authorization callback returns to that conversation's canonical session URL. The callback tab signals the original tab through `BroadcastChannel`; the original suspended native question then verifies the connection and continues the same tool call. A manual continue action remains as a fallback. This avoids local storage and preserves the native Harness question, receipt, and replay lifecycle.

The native connection card uses smaller toolkit marks and remains a durable inline conversation event. After verified authorization, the settled tool result renders a compact persistent connected receipt in the same session; real app workflows then continue from their preserved Composio plan. Pure status checks conclude from that receipt without another model step. The HIVE persona asks for no narrated reasoning on obvious direct answers or single-tool dispatches, and limits materially useful visible reasoning to four short sentences.

## Consequences

Pure named-app status checks become cheaper and exact, while real app work keeps Composio's semantic discovery quality. Successful OAuth returns can resume the suspended native interaction automatically. The callback requires a configured public HIVE base URL and browser support for `BroadcastChannel`; the existing manual continue action remains the compatibility fallback.

## Alternatives considered

- Add an Instagram-specific routing rule: rejected because each future app would require another exception and the authenticated toolkit directory is authoritative.
- Keep semantic search for status checks: rejected because operation relevance is not application identity.
- Poll indefinitely in the original HTTP request or persist callback state in local storage: rejected because web requests should remain bounded and embedded storage can be unavailable.

## Verification

Focused connected-app, callback, connection-question, browser-plugin, and shipped-preset tests cover exact toolkit selection, the absence of semantic search during status checks, callback construction and delivery, native continuation, and existing search/resume behavior.
