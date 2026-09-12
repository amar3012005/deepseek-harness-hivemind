# HIVE connected apps

The HIVE bridge registers authenticated Composio discovery and execution tools without replacing the Harness agent loop or conversation renderer.

## Discovery reuse

Unsuccessful searches carry versioned discovery metadata through native tool-result projection. The bridge reads committed receipts from the current conversation, scoped to the Composio router session, workflow, explicit apps, and known identifiers. Exact negative repeats reuse evidence; consecutive negative refinements stop contacting the provider after `maxUnmatchedSearches` (default 2). `discoveryCacheTtlMs` (default 300000) bounds freshness. New identifiers, provider execution, connection management, or a replacement router session invalidate reuse. Failed provider calls do not establish a capability limitation.

## Model Experience

`maxDiscoverySearches` (default 2) additionally bounds consecutive discovery-only calls, including nonempty but insufficient candidate lists. Provider execution or connection work advances the workflow and resets this budget. Exhaustion returns existing-evidence guidance, not an unsupported-provider claim. Mixed primary-tool ownership is rejected for explicitly scoped app requests rather than authorizing an unrelated toolkit.

The model still selects skills, searches, and executes tools. A cached negative result preserves its next-action guidance and distinguishes unsuccessful discovery from proof of unsupported provider functionality. It does not report a provider operation as executed. Existing native model history and KV-cache behavior are unchanged; saved provider requests do not eliminate the model step that requested them.

## Known Limitations and Deferred Work

Selected execution contracts preserve complete property schemas and root schema keywords through repeated projection. Returned planning steps and pitfalls are not character-truncated. Ajv validates the complete selected contract locally before any provider execution. The original search, schema, and provider responses are written to session-authorized private spill storage before the bounded model projection is returned.

This cache does not reuse live app reads or connection authorization. Successful search/schema caching requires authoritative versioned schemas and connection invalidation. Durable negative lookup currently scans the owning session log. The bridge has no separate invariant companion because its cache is derived directly from committed tool receipts rather than an independent persistent store.
