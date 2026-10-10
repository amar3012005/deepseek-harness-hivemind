# Agent Note: Runtime team message summaries

Status: implemented

English | [中文](2026-10-10-runtime-team-message-summary.zh.md)

## Problem

Detailed employee assignments and nightly findings appeared in full in the chat bubble even when
agent instructions requested brief visible updates. Shortening the underlying mailbox message would
remove context needed by the receiving employee and by Runtime's review.

## Decision

The existing persistent-room message envelope accepts an optional `summary`: one nonempty line of at
most 240 characters. The sender supplies this display copy alongside the complete `text`. Both are
retained in the outbox, receiving room and model-facing envelope. Reusing a message key requires the
identical summary and full text.

The chat bubble uses a valid explicit summary, then the existing validated assignment projection or
short original prose. A long historical message without a summary gets a neutral update notice; it
never gets an inferred success claim. The complete original envelope stays available in the closed
Agent message disclosure, including in company chat. Artifact buttons retain their existing exact
saved-receipt behavior.

Runtime and HyperAgent personas distinguish brief stage narration from complete underlying messages.
Runtime resolves routine doubts within existing authority and coordinates proactive specialists.
Typed delegated blockers can supply their own notification reference without a redundant blocking
question. Native approval, downstream denial, tenant, provider and accepted current-revision review
boundaries remain unchanged. Full access wording describes explicit exemptions; remaining asks under
the native never policy are rejected.

## Alternatives considered

**Shorten stored messages.** This removes assignment details and technical evidence required by
employees and the nightly report.

**Infer summaries from detailed prose.** This risks inventing an outcome. Historical messages use a
neutral notice instead; current senders supply the supported summary explicitly.

**Change the approval service.** The issue is instruction and presentation clarity. Native authority
remains with the existing services.

## Consequences

Detailed communication remains durable and inspectable without filling the visible conversation.
Summary metadata is optional for older sessions; it describes a message and grants no authority.
Future sender behavior still requires real-model verification after release.