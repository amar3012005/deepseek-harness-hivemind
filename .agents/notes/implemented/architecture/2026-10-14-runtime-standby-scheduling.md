# Runtime standby scheduling

Runtime and Brain can use separate runners while preserving the existing tenant-scoped session database. The web runner and HQ control require the native Schedule service even when automatic work must remain inactive. Removing that service prevents profile activation. Replacing its PostgreSQL provider with the JSON domain removes tenant authorization from global schedule catalogs.

The owning PostgreSQL plugin exposes independent delivery and management configuration. Both default to enabled, preserving existing deployments. A standby runner disables both: no timers or due scans start, direct dispatch returns without acquiring a connection, and task insertion, update and deletion reject before writing. Authenticated reads retain their existing membership checks, RLS scope and native records. Durable deployment ownership is required before enabling shared schedule delivery. No agent-loop or persisted-event changes are needed.

Focused regression cases verify disabled dispatch performs no database access, existing default wake behavior remains unchanged, and read-only management retains tenant scope while refusing mutation SQL.
