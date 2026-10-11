# Agent Note: Native chat axis and connection cancellation

Status: implemented

English | [中文](2026-10-11-native-chat-axis-and-connection-cancellation.zh.md)

## Problem

Viewport translations and an employee-only transcript width separated the native transcript and composer. Persisted connection cards had no cancellation callback and remained visible after the user abandoned their request.

## Decision

Use the existing native conversation content width and pane axis. Keep one compact connection card with expandable reason and existing actions. The existing connected-app tool accepts cancel_connection with exact saved workflow and request call identities. Its existing session receipt records cancelled; projections remove only that request, and continuation refuses it. No provider account is disconnected. Runtime closes a request when the user explicitly declines it; changing topics alone leaves it pending.

## Alternatives considered

A viewport offset is rejected because Preview and navigation change the native pane geometry. Local dismissal is rejected because reload would restore the request. Matching arbitrary recent text is rejected because it could cancel unrelated work.

## Consequences

The complete record remains saved. A renewed explicit request uses a new workflow. Cancellation does not approve access, change email-delivery receipts, or claim provider success.
