# Schedule task UI

The native Harness Schedule UI uses the shared authenticated `remote.schedule` service. It provides the Automation tasks page, a current-session header catalog, transcript cards for created tasks, and a right-panel task detail view. No second Harness application is mounted.

## Management

The catalog contains active and inactive tasks with their original session identities. Search, status filtering, edit, delete, and delivery history use the same authoritative source. An edit submits the complete previously observed record so a concurrent delivery or edit returns a conflict instead of overwriting newer state. Deleting a task removes its saved delivery history while retaining the original conversation and queued work.

Opening a catalog or task detail does not resume the session. Following its session link does. Task tabs retain their task binding across layout restoration; missing or deleted tasks display an explicit unavailable state. History displays saved instructions and occurrence times, with bounded pagination and retention notices.

The HIVE profile enables the package alongside tenant PostgreSQL storage. Its session header shows only that session's active tasks. The task card opens the native right panel. The domain-backed native profile also exposes the Automation tasks sidebar page. The current fork has no upstream session-row hover contribution seats; their standalone components are retained for a later shell upgrade.

## Model Experience

- Tools and prompts: none; the host Schedule package owns the tool definitions and delivery messages.
- Tokens and KV cache: no model request is made by task management, history, search, or task preview.

## Known Limitations and Deferred Work

A delivery record means the inbox accepted the scheduled message, not that its model turn succeeded. The turn card uses this fork's existing turn-tail selection seat, so it takes precedence over lower-priority turn-tail contributions on turns that create a task. The HIVE outer sidebar is not rebuilt by this package.
