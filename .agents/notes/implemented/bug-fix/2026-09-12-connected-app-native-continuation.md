# Agent Note: Native connected-app continuation

Status: implemented

English | [中文](2026-09-12-connected-app-native-continuation.zh.md)

## Problem

A disconnected Composio search settled its tool call and a browser button sent a synthetic user message to continue. That started a new turn, repeated context and skill routing, and could rediscover a different provider instead of resuming the original Composio session and plan.

## Decision

The connected-app bridge keeps the original search tool call pending through the existing `userQuestions` service. It publishes a standard question with two ordinary answer options and an app-neutral, validated HIVE presentation marker carrying the session-bound authorization URL. The HIVE client plugin claims only that marked request from the existing Remote Event waterfall and renders the provider card with exactly two actions inside the running connected-tool row. The resident composer remains mounted below the transcript. Opening authorization does not settle the question; requesting continuation verifies the connection through `COMPOSIO_WAIT_FOR_CONNECTIONS` with the original session ID. Only verified active evidence releases the original compact search result, selected tools, and execution contracts back to the same agent turn.

The old HIVE browser callback that sent “I've connected …” as a new conversation message is removed. Headless callers without a live agent retain the compact settled connection receipt.

## Alternatives considered

**Send another user message.** This is durable as ordinary chat, but it restarts model routing and makes the model reconstruct a workflow the server already owns.

**Replace the resident composer.** The composer chain can present pending interactions, but it separates the authorization controls from the tool that requested them and visually replaces the normal input position. The connected tool view already owns the correct transcript location and reads the same Session pending interaction.

**Import the native question carrier into the HIVE UI plugin.** Client bundle purity forbids cross-plugin runtime imports. The HIVE plugin therefore uses the public Cordis Remote Event and pending-interaction services, while the unmodified generic question plugin remains the fallback for every unmarked request.

**Change the agent loop.** The loop already supports pending human interaction and requires no special Composio branch.

## Consequences

Connection authorization pauses inference without another model step, and successful verification resumes the original Composio plan without another search. The inline controls remain next to the running tool evidence without displacing the composer. The marker and UI are provider-neutral, and the request remains compatible with the generic question UI because both labels are ordinary question options. No native Harness loop, question package, or renderer code changes. Focused host and HIVE client tests cover presentation validation, inline placement, non-settling authorization, same-waterfall continuation, session reuse, active verification, and compact contract preservation.

An interrupted runner process still requires the broader durable workflow recovery contract; this decision removes duplicate turns but does not claim process-restart recovery by itself.
