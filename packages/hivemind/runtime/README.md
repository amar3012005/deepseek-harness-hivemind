---
description: "Authenticated HIVE-MIND company context, memory recall, and HyperAgent discovery for DeepSeek Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-hivemind-runtime

English | [中文](README.zh.md)

## Summary

`dsh-hivemind-runtime` binds a Harness agent to the HIVE-MIND identity saved by ICARUS. It validates the local credential, resolves user and organization scope server-side, and injects a compact company brief. HIVE mode exposes one progressive meta-tool, retains recent completed user/final-answer exchanges, and omits prior tool payloads from later model requests. Credentials and tenant identifiers never enter model-visible schemas or results.

## Use this package

Mount the plugin in an agent preset that provides `tools` and `skills`:

```yaml
- insert:
    - id: hivemind-runtime
      name: '@deepseek-ai/dsh-hivemind-runtime'
      config:
        agentFeaturesEnabled: true
        legacyToolsEnabled: false
        icarusConfigPath: '~/.icarus/config.json'
        requestTimeoutMs: 20000
        responseMaxBytes: 2097152
        profileContextMaxChars: 12000
        profileBriefMaxChars: 1200
        recallResultLimit: 5
        recallItemMaxChars: 16000
        historyTurns: 5
        historyMaxChars: 8000
```

The ICARUS credential must be a regular file owned by the current user and not writable by group or others. The runtime accepts only `https://core.singulancelabs.com` or a loopback API origin, refuses redirects, limits response bodies, and applies an explicit request timeout.

## Semantics

The runtime composes three independently testable capabilities: `hivemind-context` owns the awaited prompt projection, `hivemind-memory` owns the model-facing tool, and `hivemind-employee-directory` validates exact organization HyperAgent profiles. Before a user message wakes the agent, a scoped turn policy hides HIVE-owned routers that the request cannot need. Greetings and direct profile questions receive neither router, ordinary company work receives `hivemind_meta`, and connected-application work may receive both `hivemind_meta` and `hivemind_connected_task`; native Harness tools are never changed by this policy. The restriction remains through every step in the turn and is lifted when the turn stops. The history projection retains at most `historyTurns` completed direct-user/final-assistant exchanges within `historyMaxChars`; reasoning, tool calls, and tool outputs remain in the append-only session log but leave later model requests.

`hivemind_meta` supports `context`, `recall`, and `profiles`. Recall exposes one deduplicated top-five list, preserves material content and citation metadata, and caps each evidence item at `recallItemMaxChars`. Its focused schema supports source, project, time, explicit tag, media-kind, filename, and entity filters. No operation accepts a user or organization identifier.

## Model Experience

The model sees one compact organization message, recent completed conversation, and only the HIVE-owned router schemas selected before prompt assembly. Detailed company-brain instructions remain registered for explicit user invocation rather than appearing in every model skill catalog. The initial brief is capped by `profileBriefMaxChars`; a direct identity request receives bounded authenticated profile context without relying on model tool selection, while other detailed company work loads it through `context`. A current-turn tool result remains available for synthesis and is omitted from later turns by the history projection.

## Known Limitations and Deferred Work

- The integration is read-only: employee execution and connected-application actions remain separate capabilities.
- Browser authentication uses local ICARUS configuration and is not a hosted multi-tenant credential service.
- Progressive recall pagination beyond the first top-five result set is deferred.

## Dev Note

The source package owns authentication-backed composition and local connection routes. Keep credentials and tenant authority out of browser code, tool arguments, and model-visible results.
