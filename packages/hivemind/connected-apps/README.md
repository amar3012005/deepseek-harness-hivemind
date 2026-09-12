# HIVE connected apps

The HIVE bridge registers authenticated Composio discovery and execution tools without replacing the Harness agent loop or conversation renderer.

## Discovery reuse

Unsuccessful searches carry versioned discovery metadata through native tool-result projection. The bridge reads committed receipts from the current conversation, scoped to the Composio router session, workflow, explicit apps, and known identifiers. Exact negative repeats reuse evidence; consecutive negative refinements stop contacting the provider after `maxUnmatchedSearches` (default 2). `discoveryCacheTtlMs` (default 300000) bounds freshness. New identifiers, provider execution, connection management, or a replacement router session invalidate reuse. Failed provider calls do not establish a capability limitation.

## Model Experience

The model still selects skills, searches, and executes tools. A cached negative result preserves its next-action guidance and distinguishes unsuccessful discovery from proof of unsupported provider functionality. It does not report a provider operation as executed. Existing native model history and KV-cache behavior are unchanged; saved provider requests do not eliminate the model step that requested them.

## Known Limitations and Deferred Work

This cache does not reuse live app reads or connection authorization. Successful search/schema caching requires authoritative versioned schemas and connection invalidation; the existing compact execution contracts are not a substitute for complete JSON Schema validation. Durable negative lookup currently scans the owning session log. The bridge has no separate invariant companion because its cache is derived directly from committed tool receipts rather than an independent persistent store.
