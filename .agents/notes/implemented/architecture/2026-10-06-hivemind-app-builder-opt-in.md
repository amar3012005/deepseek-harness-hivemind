# Opt-in HIVEMIND App Builder

## Decision

Runtime and HyperAgent presets mount a native App Builder consumer only when HIVE_APP_RUNTIME_ENABLED is true. The same flag gates Core routes; production remains disabled. Existing employee lifecycle, loop, native tool execution, scoped skill discovery and progressive loading remain owners.

## Authority

The consumer derives the organization and user from HivemindExecutionScope, preserves its trusted profile and rejects projectId before signing. Models cannot supply tenant IDs, origins or credentials. Core rechecks membership, manages permissions, optimistic versions and idempotent receipts. Future project authorization must be explicit rather than treating project grants as organization grants.

## Schemas and UI

AppSpec v1 tool schemas mirror Core's native dialect export. Actual native registration exposed unsupported const-only nodes and union/type combinations; Core conversion and the generated snapshot now use typed constants and union-only nodes. The current native projection returns no HyperAgent room-history rail; Your CRM navigation belongs to the outer product sidebar. No native rail is reintroduced.

## Verification

Focused native registry testing exercises tool schema registration, discoverable skill, signed HTTP request conversion, invalid tenant arguments, project denial before dispatch and disposal. Core-backed publication and renderer integration require the isolated application fixture. No production release occurs in this task.
