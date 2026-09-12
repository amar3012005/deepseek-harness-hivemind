# Agent Note: HIVE production hardening

Status: implemented in source

## Decisions

Composio search, schema, and provider responses are persisted to session-authorized private spill storage before projection. Selected contracts are validated with Ajv, including nested constraints, before provider execution. Completed history remains a bounded user/final-answer projection while original events remain available for replay.

The HIVE recent-session rail reuses native session rows and adds their native action menu. It offers Rename, Fork, Share, and Archive. Permanent deletion is not exposed because the session log is append-only and remains the replay authority.

## Boundaries

The native agent loop, conversation renderer, and session log are unchanged. No provider-specific or user-specific routing was added. Live connected reads and connection state are not cached. Browser asset caching is owned by the HIVE edge worker and is version-aware rather than an authoritative workflow store.
