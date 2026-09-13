# HIVE connected apps

## Summary

The HIVE bridge registers authenticated Composio discovery and execution tools without replacing the Harness agent loop or conversation renderer.

## Discovery reuse

Unsuccessful searches carry versioned discovery metadata through native tool-result projection. The bridge reads committed receipts from the current conversation, scoped to the Composio router session, workflow, explicit apps, and known identifiers. Exact negative repeats reuse evidence; consecutive negative refinements stop contacting the provider after `maxUnmatchedSearches` (default 2). `discoveryCacheTtlMs` (default 300000) bounds freshness. New identifiers, provider execution, connection management, or a replacement router session invalidate reuse. Failed provider calls do not establish a capability limitation.

## Model Experience

### Connected workflow evidence and continuation

#### What the model sees

The model selects skills, searches, and provider tools through `hivemind_connected_task`. Search results contain bounded plans and exact selected execution contracts. An active connection receipt carries `next_action: "continue_current_request"` and stays in the same native turn. On a later turn, an unfinished workflow adds one plugin user message with source `dsh-hivemind-connected-apps/workflow`; it contains the workflow session ID, original atomic queries, selected tools, exact contracts, connection state, and next action reconstructed from committed tool events.

##### Unfinished workflow preamble

```markdown
## Unfinished connected-app workflow
This state is reconstructed from durable receipts in this conversation. If the current request continues it, resume this session without repeating search, checking status separately, or using HIVE memory for connected-app evidence. If the user changed tasks, leave it pending.
```

#### Token effect

The registered bridge tool schema is present while connected tools are enabled. Each search or provider call adds one bounded receipt. Non-executable schema annotations and duplicated MIME transport trees are excluded from the model projection, while plans, validation constraints, readable evidence, and the private full-receipt reference remain. `maxDiscoverySearches` (default 2) bounds consecutive discovery-only calls. The unfinished projection is absent from the originating turn and appears only while a prior workflow remains incomplete.

#### KV Cache effect

Append-only within a turn and when an unfinished projection is added on a later turn. Stable system and tool-schema prefixes remain reusable. The bridge does not rewrite native completed history; provider execution or completion removes the need for future workflow projection.

### External actions

Selected mutating tools use the native Harness approval seam after search and argument validation. One `allowed-once` decision executes the exact selected Composio tool once; rejection, cancellation, or an unavailable approval channel prevents provider execution. The bridge does not return an intermediate approval receipt that requires another model step.

## Known Limitations and Deferred Work

- Selected execution contracts preserve complete property schemas and root schema keywords through repeated projection. Non-executable JSON Schema annotations such as `examples` and `$comment` are omitted, while descriptions, nested constraints, and validation keywords remain. Returned planning steps and pitfalls are not character-truncated. Ajv validates the complete selected contract locally before any provider execution. The original search, schema, and provider responses are written to session-authorized private spill storage before the bounded model projection is returned. Provider projections keep readable evidence and requested identifiers but omit duplicated MIME transport trees, headers, and encoded parts.

- This cache does not reuse live app reads or connection authorization. Successful search/schema caching requires authoritative versioned schemas and connection invalidation. Durable negative lookup currently scans the owning session log. The bridge has no separate invariant companion because its cache is derived directly from committed tool receipts rather than an independent persistent store.
