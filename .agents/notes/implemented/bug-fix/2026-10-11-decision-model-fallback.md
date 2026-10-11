# Agent Note: Decision model fallback

Status: implemented

English | [中文](2026-10-11-decision-model-fallback.zh.md)

## Problem

A transient Mercury failure leaves authorized activity pending. The current OpenRouter credential also rejects both Mercury and Jev with HTTP 402; changing the model alone cannot restore that account's capacity.

## Decision

The existing dedicated Decisions provider accepts the pinned Mercury, free Mercury and Jev models. A server-configured alternate receives the identical typed state and questions after primary transport or output failure. The web bundle selects Jev as Mercury's alternate and permits six seconds for primary inference within an eight-second total deadline. The earlier 1.2-second primary and three-second total budget timed out during live recovery through the verified free gateway route. Successful responses return immediately; the deadline is a maximum, not a mandatory wait. Caller cancellation stops recovery. Each response must pass the original keyed primitive and normalized distribution validation before consumption. Credentials are resolved for each attempt; bodies and secrets remain unlogged.

## Alternatives considered

**Force notification when inference fails.** Rejected because provider failure cannot establish signal usefulness or urgency. The existing pending ledger preserves recovery without fabricated decisions.

**Switch to another model on the same unfunded credential.** Insufficient because both actual probes returned HTTP 402. Deployment still requires a working credential route and live proof.

**Add another event receiver.** Rejected because existing event identity, classification retry and native delivery already preserve duplicate prevention.

## Consequences

There are at most two model attempts per assessment and one validated decision. A valid primary makes no alternate request. Shared account billing or gateway authentication failure can still defeat both attempts; the event remains pending until capacity is restored. No session, authority or delivery contract changes.
