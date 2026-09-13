# Agent Note: HIVE connected workflows continue after connection evidence

Status: implemented

## Problem

An active `connection_status` receipt called the Harness turn-conclusion seam. A broader request such as sending a previously drafted message therefore stopped after reporting that the provider was connected. When the user said “continue” in a later turn, completed-history projection correctly omitted the old tool transcript, but it also left the model without the original connected-app intent and execution contract. The model could repeat connection discovery, ask for details already established, or incorrectly search HIVE memory.

Provider read receipts also repeated MIME transport trees beside already-decoded evidence, and schema examples increased the model projection without contributing executable validation. Email projections could omit requested evidence because provider-specific keys such as `sender`, `messageTimestamp`, and `messageText` did not match canonical requested names. The private spill locator then appeared in model context and could be mistaken for a web-research URL.

## Decision

The HIVE connected-app bridge treats an active connection as evidence inside the current native Harness turn, not as a terminal outcome. Only an unresolved connection card concludes that turn. The model remains responsible for choosing and executing the next tool.

For later-turn continuation, `agent/pre-step` derives one compact unfinished-workflow projection from durable `hivemind_connected_task` calls and results already committed to the owning conversation. The projection carries the workflow session, original atomic queries, selected tools, exact contracts, connection state, and next action. No process-local cache is authoritative, no replacement planner is added, and no app-specific routing rule is introduced.

Search contracts omit only non-executable schema annotations. Provider result projection omits transport-shaped MIME subtrees while preserving decoded evidence. Common mail fields are canonicalized at this adapter boundary, while the full provider receipt remains in session-authorized private spill storage. Only content-free storage metadata is model-visible; private locators and retrieval hints are not.

## Consequences

The native agent loop, tool rows, connection card, replay, and renderer remain unchanged. Connected work can resume after authorization or a later user message without repeating discovery, and an already-connected provider no longer consumes a turn by itself. Model context is smaller without weakening server-side schema validation or removing user-visible evidence.

One selected non-mutating provider tool executes at most once per native turn unless the model supplies the provider's explicit pagination cursor. Exact Ajv contract validation still rejects unsupported arguments before execution; the bridge does not sanitize, rename, or silently remove them.

An unfinished workflow remains visible to the model until provider execution completes. If the user changes tasks, the projection explicitly leaves the prior workflow pending rather than silently mutating or discarding it.

Mutating selected tools use the native Harness pre-execution approval seam. The
model calls the exact selected execute contract once; Harness pauses that call
for `Allow once` or `Reject`, and only an allowed call reaches Composio. This
removes the bridge's former `approval_required` prepare receipt and the repeated
model confirmation loop while retaining native replay and cancellation.

## Alternatives considered

**Conclude every connection receipt and rely on recent chat text.** Rejected because completed-history compaction intentionally removes tool transcripts, so the original intent and provider contract are not reliable continuation state.

**Add a deterministic intent router for connection follow-ups.** Rejected because it duplicates native model planning and would require provider- or phrase-specific behavior.

**Keep workflow state only in an in-memory map.** Rejected because runner restarts and conversation switching would lose the authoritative plan and could mix concurrent workflows.

## Verification

The connected-app package tests cover a single-search and single-fetch latest-email request, canonical email field projection, private oversized receipts without web locators or approval, active-connection direct execution, OAuth continuation with the original session and contract, explicit pagination, exact nested schema validation, and readable provider evidence without duplicated MIME transport. A targeted TypeScript build compiles the same HIVE plugin mounted by the preview runner.

The preview browser canary proved a fresh bounded Gmail read completes with one
search and one provider execution. A fresh Gmail mutation produced one native
approval card after search; rejecting it produced a durable rejected result and
did not execute the provider write.
