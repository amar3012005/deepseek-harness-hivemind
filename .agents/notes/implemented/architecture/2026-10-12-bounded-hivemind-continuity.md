# Agent Note: Bounded HIVE-MIND continuity on the current runner

Status: implemented

## Problem

An old unanswered call or unreviewed teammate record previously pinned every subsequent surface node, allowing more than a megabyte of unrelated conversation into an ordinary wake. Keep individual pending call/result islands and peer records, replacing only the intervening closed history through native surface replacements. Source events are never removed.

## Decision

The Runtime host contributes a deterministic host-only session projection for current saved task, contract, review, artifact and handoff pointers. It serves a bounded record view each turn; native domain records remain authoritative. The existing native sessionQuery service supplies an own-session paged reader because the general workspace tool scope is broader than this multi-tenant consumer requires. No cross-room identifier is accepted.

Text-only oversized tool receipts are replaced with explicit excerpts plus original event sequence references. Native outcome and message identity remain unchanged. No LLM summarization or core loop modification is introduced. Fixed schema/system cost and large current requests remain outside the history budget and must be measured separately.

## Alternatives considered

Keeping the entire suffix after an approval retains unrelated history. Model summaries add generation work and are unnecessary for exact saved state. Replacing the native loop would broaden the change without fixing the selection error.

## Consequences

Acceptance requires durable replay, native pending checkpoint identity, exact paged history, immutable runner artifact and authenticated long-session verification.
