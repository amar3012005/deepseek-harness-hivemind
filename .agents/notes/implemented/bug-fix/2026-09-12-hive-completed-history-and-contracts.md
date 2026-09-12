# Agent Note: Completed history and exact discovery guidance

Status: implemented

## Problem

History projection required a profile anchor that connected-app turns deliberately omit. Completed tools therefore leaked into subsequent requests. Discovery projection also truncated planning guidance and nested schema constraints.

## Decision

Use the latest completed turn boundary for native surface replacement, retaining current system/profile nodes and current-turn work. Keep original events for replay. Preserve full selected schema keywords, steps, and pitfalls through repeated tool-result projection. No native loop, renderer, provider-specific routing, or live-read cache changes.

## Alternatives and limitations

Reducing current execution contracts sacrifices necessary evidence. Deleting log events breaks replay. Neither is needed for completed-history projection. Interrupted turns remain intact. Full JSON Schema enforcement and original provider receipt archival remain separate work.

## Verification

Focused context, connected-app, and runtime suites pass 84 tests; both changed packages type-check. Added regression coverage for connected-app history without a profile and lossless repeated schema/plan projection.
