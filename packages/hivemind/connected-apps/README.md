# HIVE connected apps

## Summary

The HIVE bridge registers authenticated Composio discovery and execution tools without replacing the Harness agent loop or conversation renderer.

## Discovery reuse

Unsuccessful searches carry versioned discovery metadata through native tool-result projection. The bridge reads committed receipts from the current conversation, scoped to the Composio router session, workflow, explicit apps, and known identifiers. Exact negative repeats reuse evidence; consecutive negative refinements stop contacting the provider after `maxUnmatchedSearches` (default 2). `discoveryCacheTtlMs` (default 300000) bounds freshness. New identifiers, provider execution, connection management, or a replacement router session invalidate reuse. Failed provider calls do not establish a capability limitation.

## Model Experience

### Connected workflow evidence and continuation

#### What the model sees

The model selects skills, searches, and provider tools through `hivemind_connected_task`. Search results contain bounded plans and exact selected execution contracts. An atomic query may declare exact `result_fields`; these names are retained with the workflow but are not sent to Composio search. Provider execution then projects only matching fields and their structural containers. The projection reports `projection_status: "incomplete"` when any requested field is absent, and the model must report that gap rather than claim the evidence was returned. An active connection receipt carries `next_action: "continue_current_request"` and stays in the same native turn. On a later turn, an unfinished workflow adds one plugin user message with source `dsh-hivemind-connected-apps/workflow`; it contains the workflow session ID, original atomic queries, selected tools, exact contracts, connection state, and next action reconstructed from committed tool events. An unchanged projection already visible in the session is reused; changed state gets one new projection. Selected mutating tools require the native approval decision after search and argument validation; rejection, cancellation, or an unavailable approval channel prevents provider execution. A successful approval executes only the selected tool once. Rejection or cancellation is terminal for that proposed execution, and the bridge returns no intermediate approval receipt that forces another model step.

##### Unfinished workflow preamble

```markdown
## Unfinished connected-app workflow
This state is reconstructed from durable receipts in this conversation. If the current request continues it, resume this session without repeating search, checking status separately, or using HIVE memory for connected-app evidence. If the user changed tasks, leave it pending.
```

#### Token effect

The registered bridge tool schema is present while connected tools are enabled. Each search or provider call writes one bounded receipt to the session log. Non-executable schema annotations and duplicated MIME transport trees are excluded from the model projection, while plans, validation constraints, requested evidence, and the private full-receipt reference remain. Exact `result_fields` reduce execution evidence without changing provider discovery or execution arguments. `maxDiscoverySearches` (default 2) bounds consecutive discovery-only calls. The unfinished projection is absent from the originating turn and appears only while a prior workflow remains incomplete.

#### KV Cache effect

The bridge reuses an unchanged workflow or receipt projection already visible in the live session and adds a fresh projection only when its state changes or history compaction removes the prior evidence. Full provider receipts remain durable and private. Stable system and tool-schema prefixes remain reusable. The bridge does not rewrite native completed history; provider execution or completion removes the need for future workflow projection.

## Known Limitations and Deferred Work

- Selected execution contracts preserve complete property schemas and root schema keywords through repeated projection. Non-executable JSON Schema annotations such as `examples` and `$comment` are omitted, while descriptions, nested constraints, and validation keywords remain. Returned planning steps and pitfalls are not character-truncated. Ajv validates the complete selected contract locally before any provider execution. The original search, schema, and provider responses are written to session-authorized private spill storage before the bounded model projection is returned. Provider projections keep readable evidence and requested identifiers but omit duplicated MIME transport trees, headers, and encoded parts.

- This cache does not reuse live app reads or connection authorization. Successful search/schema caching requires authoritative versioned schemas and connection invalidation. Durable negative lookup currently scans the owning session log. The bridge has no separate invariant companion because its cache is derived directly from committed tool receipts rather than an independent persistent store.
