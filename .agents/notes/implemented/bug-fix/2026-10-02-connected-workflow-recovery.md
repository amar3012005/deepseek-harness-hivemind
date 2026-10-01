# Agent Note: Connected workflow recovery

Status: implemented

English | [中文](2026-10-02-connected-workflow-recovery.zh.md)

## Problem

Discovery discarded supporting tools, result filters hid resource IDs, and retry keys included a fresh call ID. Multi-step tasks could lose their report and duplicate an interrupted write.

## Decision

The shared connected-app gateway retains selected primary and related slugs and restores workflow IDs from session evidence. Execution projections are step-specific and retain actual resource identifiers. Checkpoints and write intents use the existing session receipt event and are flushed before dispatch. Stable operation IDs reuse confirmed receipts; pending writes require reconciliation. Private receipt reads retain Core field, owner, and session authorization.

## Alternatives considered

**Blindly retry interrupted writes.** Rejected because the provider may already have sent the email.

**Expose the full raw receipt.** Rejected because MIME payloads and private provider fields should remain bounded and governed.

## Consequences

Both chat modes share recovery semantics without an agent-loop change. Checkpoints are advisory working notes, not verified completion. Models must checkpoint their report and follow the evidence; external failures and expired private receipts still require recovery. No end-to-end external send is claimed by compilation or container health.
