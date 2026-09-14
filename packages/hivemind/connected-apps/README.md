# HIVE connected apps

## Summary

The HIVE bridge registers authenticated Composio discovery and execution tools without replacing the Harness agent loop or conversation renderer. Full provider responses are encrypted in the HIVE Control Plane; only a bounded contract-driven projection enters model history.

## Discovery reuse

Unsuccessful searches carry versioned discovery metadata through native tool-result projection. The bridge reads committed receipts from the current conversation, scoped to the Composio router session, workflow, explicit apps, and known identifiers. Exact negative repeats reuse evidence; consecutive negative refinements stop contacting the provider after `maxUnmatchedSearches` (default 2). `discoveryCacheTtlMs` (default 300000) bounds freshness. New identifiers, provider execution, connection management, or a replacement router session invalidate reuse. Failed provider calls do not establish a capability limitation.

## Model Experience

### Connected workflow evidence and continuation

#### What the model sees

The model selects skills, searches, and provider tools through `hivemind_connected_task`. Search results contain bounded plans and exact selected execution contracts. An atomic query may declare exact `result_fields`; these names are retained with the workflow but are not sent to Composio search. Provider execution then projects only matching fields and their structural containers. Common mail evidence names are canonicalized at this boundary: `sender`/`from`, `received_at`/provider timestamps, and `snippet`/decoded message text. If none match, the existing bounded evidence projection is returned so a mistaken field name cannot silently discard the receipt. An active connection executes the selected provider tool directly without connection-management or wait calls. A connection-required receipt carries `next_action: "continue_current_request"`; after OAuth, the original router session, selected tool, and exact contract are reconstructed from committed events instead of rediscovery. The authenticated Composio router session is restored for the same HIVE user and conversation. Search remains the authorization boundary for a new provider operation; continuing or dependent steps reuse the returned workflow session and selected contract. Provider execution identity is the stable hash of `workflow_session_id + planned_step_id + tool_slug + schema_hash + canonical_arguments_hash`. An identical retry reuses its receipt, while a changed query, recipient, cursor, or other argument is a distinct execution and reaches the provider. Native tool-call ids are deliberately excluded so a runner retry cannot duplicate an approved write. The tool result stores execution diagnostics as presentation metadata rather than model content: workflow session, contract-cache hit, schema hash, arguments hash, execution key, and any reused receipt id. The native inspection UI can expose these fields without teaching the model to orchestrate idempotency.

##### Connection resume preamble

```markdown
## Connected-app resume required
A user-visible connection flow for this conversation requires an explicit resume. Reuse this session without repeating discovery. Do not infer schemas or provider data from this compact notice.
```

#### Token effect

The registered bridge tool schema is present while connected tools are enabled. Each search or provider call adds one bounded receipt. Non-executable schema annotations and duplicated MIME transport trees are excluded from the model projection, while plans, validation constraints, requested evidence, and only an opaque receipt id remain. No spill locator or retrieval hint is model-visible, so a local `file://` locator cannot become a web-research input. Semantic `result_fields` reduce execution evidence without changing provider discovery or execution arguments. An identical selected provider read executes at most once per turn; a materially different validated argument set executes under a different identity. A cursor by itself never creates unfinished workflow state. Only unresolved connection state is projected into a later turn.

#### KV Cache effect

Append-only within a turn and when a connection-resume projection is added on a later turn. Stable system and tool-schema prefixes remain reusable. The bridge does not rewrite native completed history; successful execution is terminal even when the provider response contains a pagination cursor. Selected mutating tools use the native Harness approval seam after search and argument validation. One `allowed-once` decision executes the exact selected Composio tool once; rejection, cancellation, or an unavailable approval channel prevents provider execution. A durable rejection or approval cancellation is terminal for that proposed execution and is not projected as unfinished workflow state on later turns. The bridge does not return an intermediate approval receipt that requires another model step.

## Known Limitations and Deferred Work

- Selected execution contracts preserve complete property schemas and root schema keywords in their originating search receipt. Non-executable JSON Schema annotations such as `examples` and `$comment` are omitted, while descriptions, nested constraints, and validation keywords remain. Ajv validates the complete selected contract locally before any provider execution; unsupported arguments produce a typed validation error and are neither renamed nor removed. Search, schema, and provider responses are encrypted at rest in tenant/user/session/call-scoped Control Plane receipts before the bounded model projection is returned. `hivemind_connected_receipt_read` can return only fields approved by the original contract and never returns the raw receipt.

- This cache does not reuse live app reads or connection authorization. Successful search/schema caching requires authoritative versioned schemas and connection invalidation. Durable negative lookup currently scans the owning session log. The bridge has no separate invariant companion because its cache is derived directly from committed tool receipts rather than an independent persistent store.
