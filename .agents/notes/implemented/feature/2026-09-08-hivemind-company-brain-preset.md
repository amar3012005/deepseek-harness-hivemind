# Agent Note: HIVE-MIND composes company memory over the full agent

Status: implemented

English | [中文](2026-09-08-hivemind-company-brain-preset.zh.md)

## Problem

An authenticated company assistant needs organization context and memory without replacing the coding, research, skill, subagent, workflow, compaction, or approval capabilities of the full DeepSeek Harness agent. Eagerly placing complete onboarding data or many organization tools in every request would increase prompt cost and make tenant authority model-controlled.

## Decision

The `hivemind` preset mirrors the complete `standard` agent composition and adds an isolated HIVE-MIND capability group. A server-side identity provider reads the ICARUS credential, derives user and organization scope, and supplies a bounded company brief. One tenant-free `hivemind_meta` tool progressively loads the full profile, top-five memory evidence, or exact HyperAgent profiles. Its recall schema accepts source, project, time, tag, media-kind, filename, and entity filters; media fields map to the server's existing evidence tags. A recalled filename, title, citation, or memory ID remains an internal evidence reference rather than a filesystem path. The HIVE preset keeps a compact instruction for this distinction and uses the native Harness skill loader for detailed company-brain instructions only on an applicable task. HIVE-MIND does not scan general user or project skill roots, so a greeting does not receive the large general-purpose skill catalog. The Web client mounts a browser-only connection control in `sidebar.footer.action`; it displays the authenticated email but never receives the credential.

Completed direct-user and final-assistant exchanges remain available within configured turn and character limits. Reasoning, tool calls, and tool results stay in the append-only session log but do not enter later model requests through HIVE-MIND history projection. Current-turn receipts remain available for synthesis.

The later [on-demand capability-catalog decision](../architecture/2026-09-12-hivemind-on-demand-capability-catalog.md) supersedes the earlier server-side request classifier. Direct registered tools remain available, authenticated profile data loads through `hivemind_meta context`, and the native skill catalog appears only after the model calls `hivemind_capabilities` in the current turn.

Company, website, product, people, document, and prior-work questions use the authenticated HIVE context and one focused memory lookup before external research. The profile disables the generic `web_search` registration because its credential-selected provider is not part of the HIVE deployment. A dedicated `hivemind_web_search` tool submits and polls the tenant-scoped Core web-intelligence job service through the signed runner proxy. It remains approval-gated, returns bounded source records, and is used only when internal evidence is insufficient or the user explicitly asks for current external verification. `web_fetch` remains available for a specific URL.

## Verification

Focused runtime tests cover owner-controlled credentials, origin and response limits, tenant-free schemas, typed media-filter projection, compact initial context, direct authenticated identity context, turn-level router selection, deduplicated recall with citations, HyperAgent projection, completed-exchange history, native web approval, and signed web-job submission and polling. Client tests cover sidebar placement and authenticated-email rendering. Preset validation proves the shipped composition resolves, while TypeScript builds verify host and client capability wiring.

## Alternatives considered

**Fork or simplify the Harness loop.** Rejected because HIVE-MIND must remain a complete agent and inherit upstream reasoning and execution improvements.

**Expose separate tools for each HIVE-MIND endpoint.** Rejected because a single progressive schema keeps the standing prompt compact and prevents tenant identifiers from becoming model inputs.

**Inject the complete organization profile on every request.** Rejected because most turns need only a short brief, while detailed tasks can request the full authenticated context explicitly.

**Preload capability discovery on every first step.** Superseded by the on-demand catalog because direct registered tools already cover bounded work and the native catalog can be revealed without an intent classifier.

**Inject a DeepSeek search credential into the runner.** Rejected because the existing HIVE web-intelligence service already owns provider credentials, quotas, tenant scope, and billing. A second direct provider path would duplicate policy and expose configuration failures to the model.

## Consequences

The HIVE-MIND preset must track additions to the standard preset until composition inheritance becomes available. The initial prompt no longer carries a company brief or skill catalog; the model loads authenticated profile evidence or detailed playbooks only when needed. External discovery depends on the Core web-job service and can report its bounded failure without exposing a missing provider credential. Native tools, employee execution, and recall pagination remain independent capabilities rather than hidden behavior inside the company-memory plugin.
