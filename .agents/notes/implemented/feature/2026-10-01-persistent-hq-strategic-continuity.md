# Persistent HQ strategic continuity

Status: implemented

## Problem

A company Runtime that waits for a user prompt loses the intended chief-of-staff behavior. Recent memory alone can omit employee work during a long absence, and ending a model turn does not establish deliverable acceptance.

## Decision

Initialize one canonical HQ session through the authenticated native workspace Remote. Enable only an uninitialized session and preserve explicit pauses. Native Schedule owns startup and later checkpoints; the deployment provides the fallback checkpoint interval. Native Team tasks, permissions, mailbox delivery, employee chats and the calendar retain execution ownership.

Add one progressive HQ continuity tool for strategy and inspected employee outcome batches. Persist strategy revisions and per-session reviewed positions as native session events. Acknowledgement cannot advance beyond an inspected batch. Retrieve artifacts and relevant operating memory on demand. The persona describes judgment and continuity rather than a fixed business sequence.

Private employee outcomes use a receipt-confirmed native-event outbox and the existing tenant-scoped operating-memory API. Retry with the same idempotency key on restoration or subsequent work; do not certify completion or generate reusable learning from a model promise.

## Alternatives considered

A prescribed baseline business loop would replace model judgment with an unrelated sequence. A second task store or timer would duplicate native Teams and Schedule. Latest-ten memory recall alone lacks coverage. Activating all company tenants at process startup would lack an authenticated provisioning authority. Full prompt injection of employee histories would increase latency and discard progressive context.

## Consequences

Authenticated admission initializes the Runtime without a prompt. Later browser-independent wakes preserve identity, strategy and reviewed positions. Owner-scoped employee activity remains narrower than company-wide human sharing; that policy is deliberately deferred. Native Team single-process coordination limits remain. Deterministic Loader/browser checks establish mechanics, while live model results require their own verification.
