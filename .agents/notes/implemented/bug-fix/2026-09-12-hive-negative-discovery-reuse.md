# Agent Note: HIVE negative discovery reuse

Status: implemented

## Problem

Search guidance disappeared during a second receipt projection, and a turn-local search counter could not survive continuation. Repeated discovery incurred provider calls without new evidence. An unsuccessful search also incorrectly claimed that a provider operation did not exist.

## Decision

The connected-app bridge preserves discovery metadata and continuation guidance in native tool results. It derives short-lived negative reuse from committed receipts within one authenticated conversation and router workflow. Exact queries reuse negative evidence; a configurable consecutive-negative limit bounds refinements with unchanged app scope and known identifiers. Provider execution and connection actions reset the sequence. Provider errors are not negative capability evidence. The native loop, renderer, prompts, and app-specific behavior remain unchanged.

## Alternatives considered

**Prompt-only limits** cannot prevent repeated provider work when the model ignores guidance or compaction loses it.

**Global negative capability caching** risks denying newly available tools or leaking conclusions across accounts. Reuse is workflow-local and expires.

**Caching all successful schemas and reads immediately** is deferred because compact contracts omit validation constraints and live account state can change. This change does not broaden those existing guarantees.

## Consequences

Native replay restores the same bounded discovery evidence without a new event type or database migration. New identifiers and changed workflow/session state permit fresh discovery. The bridge does not infer semantic equivalence between tasks or claim that unsuccessful searches prove provider incapability. Focused tests cover projected receipt replay across plugin restart, expiry, fresh identifiers, and provider failures.
