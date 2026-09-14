# Agent Note: Durable connected-app receipts and terminal bounded reads

Status: implemented

## Problem

The HIVE connected-app overlay treated any provider pagination cursor as an unfinished workflow. It then injected the original query, full execution schema, cursor, and retry guidance into later unrelated turns. When a provider result projection missed semantic aliases, the model repeated the same read and could mistake a process-local spill path for retrievable web evidence. Runner recreation also destroyed those spill-backed receipts.

## Decision

Provider search and execution responses are persisted through an authenticated Control Plane capability before a bounded projection reaches the model. The stored envelope is AES-256-GCM encrypted and bound to tenant, user, Harness session, turn, and tool call. The model receives only an opaque receipt id and fields approved by the selected execution contract. A scoped receipt-read tool can return those approved fields; it cannot return the raw receipt or cross an ownership boundary.

Discovery receipts remain private because they contain no provider evidence approved for later reads. Execution projection uses tool-family semantic adapters for provider fields whose wire names differ from the requested names. Calendar event records map titles, timed and all-day boundaries, timezones, and locations without treating unrelated nested summaries as event titles.

Successful bounded reads are terminal even when the provider returns another-page cursor. Only unresolved connection state, or the explicit resume immediately after that connection becomes ready, is projected into a later turn. The projection contains no query text or execution schema. The HIVE profile excludes connected-app tools from generic repeat-tool reminders because the bridge already enforces argument-aware read reuse and typed contract validation.

Execution reuse is argument-aware. The stable identity includes the Composio workflow session, a logical planned-step id, selected tool slug, selected schema hash, and a canonical hash of validated arguments. Native Harness call ids are excluded. An identical retry reuses the committed receipt, but changing a Gmail query, recipient, page cursor, or any other validated argument creates a distinct provider execution. The execution identity and receipt-reuse fields are stored only in native presentation metadata and never rendered into model content.

The HIVE persona instructs a dependent follow-up to reuse the prior workflow session and selected contract when it needs the same provider tool with different validated arguments. Discovery remains necessary for a genuinely new provider operation, not for broadening a query supported by the already-selected contract.

## Consequences

The native Harness loop, approval lifecycle, Composio provider selection, Web tools, and renderer remain unchanged. Active connections execute directly. The same user and conversation restore their Composio router session, and dependent steps reuse the selected workflow contract; search remains required for a genuinely new provider operation. Provider fields approved by the selected contract are normalized during the first execution, while a genuinely absent approved field can use one scoped receipt read rather than another provider execution. A runner restart retains provider evidence, while unrelated turns no longer inherit completed connected-app state.

## Alternatives considered

**Keep spill files and add a private file reader.** Rejected because runner recreation destroys the evidence and filesystem locators can leak into model-visible routing.

**Persist every successful pagination cursor as workflow state.** Rejected because a provider having more records does not mean the user's bounded request is incomplete.

**Patch Gmail or the native Harness loop.** Rejected because field normalization and workflow ownership belong to the connected-app adapter, while Harness already supplies the correct tool and approval lifecycles.

## Verification

Focused tests cover one-search/one-fetch email reads, answer-ready timed and all-day Calendar agenda projection, changed-query execution, identical-read reuse, presentation-only execution diagnostics, stable write idempotency across native call ids, semantic email aliases, terminal cursor behavior, direct active connections, compact connection resume, encrypted durable receipt reads, wrong-session denial, and idempotent storage. The connected-app, memory, and runtime TypeScript projects compile together.
