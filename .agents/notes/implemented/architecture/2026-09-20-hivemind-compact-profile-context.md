# HIVE-MIND compact profile context and typed read failures

## Status

Implemented on 2026-09-20 for the `hivemind-chat` profile.

## Decision

The HIVE runtime adds one bounded authenticated profile brief to the first admitted turn and reloads it on later direct profile or company questions. The brief carries server-owned user and organization versions and update timestamps when available. Runtime caching is turn-scoped, so a profile update becomes visible on the next relevant turn without invalidating another user or organization.

Expected optional HIVE read failures are returned as typed model-visible states. Entity-index absence, recall timeout, profile-context absence, and unavailable optional features are distinct from successful empty results. Authentication and authorization failures remain hard errors.

The permanent HIVE persona retains only the connected-work routing rule and the enforced Composio sequence. Detailed discovery, contract, recovery, and resumption guidance remains in the existing `composio-connected-workflows` skill and is loaded only for complex connected work. The connected-app tool, authorization checks, approvals, durable workflow state, and full private receipts are unchanged.

## Consequences

Direct profile questions no longer require an extra model step solely to call `hivemind_meta context`. Ordinary later turns do not carry the profile brief. HIVE and connected-app tool results continue to retain complete receipts outside model context while exposing bounded projections for synthesis.
