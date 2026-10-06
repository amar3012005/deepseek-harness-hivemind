# Opt-in HIVEMIND App Builder

## Decision

Runtime and HyperAgent presets mount a native App Builder consumer only when HIVE_APP_RUNTIME_ENABLED is true. The same flag gates Core routes; production remains disabled. Existing employee lifecycle, loop, native tool execution, scoped skill discovery and progressive loading remain owners.

## Authority

The consumer derives the organization and user from HivemindExecutionScope, preserves its trusted profile and rejects projectId before signing. Models cannot supply tenant IDs, origins or credentials. Core rechecks membership, manages permissions, optimistic versions and idempotent receipts. Future project authorization must be explicit rather than treating project grants as organization grants.

## Schemas and UI

AppSpec v1 tool schemas mirror Core's native dialect export. Actual native registration exposed unsupported const-only nodes and union/type combinations; Core conversion and the generated snapshot now use typed constants and union-only nodes. The current native projection returns no HyperAgent room-history rail; Your CRM navigation belongs to the outer product sidebar. No native rail is reintroduced.

## Verification

Focused native registry testing exercises tool schema registration, discoverable skill, signed HTTP request conversion, invalid tenant arguments, project denial before dispatch and disposal. Core-backed publication and renderer integration require the isolated application fixture. No production release occurs in this task.

## Progressive model visibility correction

The original opt-in package registered valid tools, but full Runtime/HyperAgents
request assembly applies the existing Playbooks capability allow-list. Because
that router had no App Runtime lane, registered CRM tools were neither advertised
nor executable after any lease. A package-only Loader proof missed this boundary.

The native `apps` lane now reveals the nine original App Runtime schemas on demand.
`create-crm` instructs the model to lease that lane first and stop if no tools are
installed. Core tools stay compact; Brain and flag-disabled presets remain absent.
The file-backed Loader proof now composes exact shipped AppBuilder and Playbooks
rows, uses a real agent ToolRuntime scope and systemPrompt.assemble, checks all
nine unmodified schemas after leasing, executes a signed preview read via the full
tool pipeline, and confirms reset hides schemas and returns UNKNOWN_TOOL.
