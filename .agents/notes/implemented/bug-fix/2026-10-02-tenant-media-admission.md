# Agent Note: Tenant media ownership and durable admission

Status: implemented

English | [中文](2026-10-02-tenant-media-admission.zh.md)

## Decision

Require server-derived organization, user and session ownership in the production media preset. Verify scoped Session persistence before returning coordinates. Bind provider operation state and artifact receipts to that owner. Use one shared runner queue across session mounts with global and organization limits and a persistent SQLite daily reservation ledger.

## Recovery and alternatives

Persist the accepted request in the Session before dispatch. On authorized session reopening, restart undispatched requests and reconcile submitted Codex requests without new generation. Reuse the original workflow identity. Persist and sync private provider intent before submission. Unknown video submissions require provider reconciliation; do not blindly repeat them. A distributed queue is deferred because production has one runner; multiple replicas must replace the in-process scheduler. Automatic recovery for closed sessions is not implemented.

## Consequences and verification

Production defaults are four global jobs, one per organization, 100 queued requests and 50 distinct admitted operations per user/organization per UTC day. Failed admitted requests consume reservations. Cancellation removes queued work; shutdown aborts workers and waits to close the ledger until active slots release. Focused tests cover owner mismatch, durable quotas, concurrent tenants, duplicate admission, cancellation, completed output ownership and ambiguous outcomes without regeneration. Provider outages and account limits remain possible; these changes do not promise zero failures or independent provider accounts per tenant.
