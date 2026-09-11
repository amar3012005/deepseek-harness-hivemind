# Agent Note: HIVE-MIND composes company memory over the full agent

Status: implemented

English | [中文](2026-09-08-hivemind-company-brain-preset.zh.md)

## Problem

An authenticated company assistant needs organization context and memory without replacing the coding, research, skill, subagent, workflow, compaction, or approval capabilities of the full DeepSeek Harness agent. Eagerly placing complete onboarding data or many organization tools in every request would increase prompt cost and make tenant authority model-controlled.

## Decision

The `hivemind` preset mirrors the complete `standard` agent composition and adds an isolated HIVE-MIND capability group. A server-side identity provider reads the ICARUS credential, derives user and organization scope, and supplies a bounded company brief. One tenant-free `hivemind_meta` tool progressively loads the full profile, top-five memory evidence, or exact HyperAgent profiles. Its recall schema accepts source, project, time, tag, media-kind, filename, and entity filters; media fields map to the server's existing evidence tags. A recalled filename, title, citation, or memory ID remains an internal evidence reference rather than a filesystem path. The HIVE preset keeps a compact instruction for this distinction and uses the native Harness skill loader for detailed company-brain instructions only on an applicable task. HIVE-MIND does not scan general user or project skill roots, so a greeting does not receive the large general-purpose skill catalog. The Web client mounts a browser-only connection control in `sidebar.footer.action`; it displays the authenticated email but never receives the credential.

Completed direct-user and final-assistant exchanges remain available within configured turn and character limits. Reasoning, tool calls, and tool results stay in the append-only session log but do not enter later model requests through HIVE-MIND history projection. Current-turn receipts remain available for synthesis.

A server-side turn policy selects HIVE-owned router visibility before prompt assembly. Greetings and direct identity requests hide both `hivemind_meta` and `hivemind_connected_task`; direct identity requests receive bounded authenticated profile context instead. Ordinary company work keeps `hivemind_meta`, external-application work keeps the connected-app router, and combined memory-to-app requests keep both. The policy uses agent-scoped tool restrictions, holds them through multi-step execution, lifts them at turn stop, and never changes native Harness capabilities.

## Verification

Focused runtime tests cover owner-controlled credentials, origin and response limits, tenant-free schemas, typed media-filter projection, compact initial context, direct authenticated identity context, turn-level router selection, deduplicated recall with citations, HyperAgent projection, and completed-exchange history. Client tests cover sidebar placement and authenticated-email rendering. Preset validation proves the shipped composition resolves, while TypeScript builds verify host and client capability wiring.

## Alternatives considered

**Fork or simplify the Harness loop.** Rejected because HIVE-MIND must remain a complete agent and inherit upstream reasoning and execution improvements.

**Expose separate tools for each HIVE-MIND endpoint.** Rejected because a single progressive schema keeps the standing prompt compact and prevents tenant identifiers from becoming model inputs.

**Inject the complete organization profile on every request.** Rejected because most turns need only a short brief, while detailed tasks can request the full authenticated context explicitly.

**Rely on every model to choose whether to call HIVE and Composio.** Rejected because small and non-native tool-calling models can call irrelevant routers or print tool syntax as text. Server-side visibility is deterministic and provider-independent.

## Consequences

The HIVE-MIND preset must track additions to the standard preset until composition inheritance becomes available. The initial prompt carries a small company brief, while each turn carries only applicable HIVE router schemas. Intent classification is deliberately conservative: unknown substantive requests retain memory access, and named connected-app requests unlock the progressive Composio router. Native tools, employee execution, and recall pagination remain independent capabilities rather than hidden behavior inside the company-memory plugin.
