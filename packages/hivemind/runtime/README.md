---
description: "Authenticated HIVE-MIND company context, memory recall, and HyperAgent discovery for DeepSeek Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-hivemind-runtime

English | [中文](README.zh.md)

## Summary

`dsh-hivemind-runtime` binds a Harness agent to the HIVE-MIND identity saved by ICARUS. It validates the local credential, resolves user and organization scope server-side, and loads authenticated profile evidence only when the model requests it. HIVE mode exposes direct bounded tools plus an on-demand capability-catalog tool, retains recent completed user/final-answer exchanges, and omits prior tool payloads from later model requests. Credentials and tenant identifiers never enter model-visible schemas or results.

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

The runtime composes three independently testable capabilities: `hivemind-context` owns the awaited prompt projection, `hivemind-memory` owns the model-facing tool, and `hivemind-employee-directory` validates exact organization HyperAgent profiles. The first model step receives the system contract, bounded completed conversation, and any current unfinished workflow state. Direct registered tools remain available, but the native skill catalog is withheld. When detailed playbook guidance is needed, the model calls `hivemind_capabilities`; the next native Harness step receives the current catalog and the model may load one relevant skill. This uses no prompt keyword classifier and does not modify the native planner, tool registry, or loop. The history projection retains at most `historyTurns` completed direct-user/final-assistant exchanges within `historyMaxChars`; reasoning, tool calls, and tool outputs remain in the append-only session log but leave later model requests.

`hivemind_meta` supports `context`, `entities`, `recall`, `save`, and `profiles`. `entities` resolves a partial or ambiguous named subject through the authenticated Core inventory; the selected `canonical_name` is then passed to `recall.entities`. It is omitted when the subject is already exact and is never a mandatory preflight for every recall. Recall exposes one deduplicated top-five list, preserves material content and citation metadata, and caps each evidence item at `recallItemMaxChars`. Its focused schema supports source, project, time, explicit tag, media-kind, filename, and entity filters. No operation accepts a user or organization identifier.

## Dev Note

The source package owns authentication-backed composition and local connection routes. Keep credentials and tenant authority out of browser code, tool arguments, and model-visible results.

## Model Experience

### Progressive HIVE capability access

#### What the model sees

The model initially sees no skill catalog or eager organization profile. It can answer from the system contract and recent completed conversation, ask one concise clarification, call a bounded registered tool directly, or request the compact catalog through `hivemind_capabilities`. Authenticated profile context is loaded only through `hivemind_meta context`. A current-turn tool result remains available for synthesis and is omitted from later turns by the history projection.

#### Token effect

The initial request pays for the direct tool schemas but not the skill catalog or organization profile. A detailed playbook adds one capability-request receipt and one native catalog only in the active turn.

#### KV Cache effect

The stable system contract and registered tool roster remain reusable. Profile evidence, catalog content, and task receipts appear after that prefix only when requested.

## Known Limitations and Deferred Work

- The integration is read-only: employee execution and connected-application actions remain separate capabilities.
- Browser authentication uses local ICARUS configuration and is not a hosted multi-tenant credential service.
- Progressive recall pagination beyond the first top-five result set is deferred.
