---
description: "A sidebar HIVE-MIND connection control for the DeepSeek Harness Web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-hivemind-connect

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-hivemind-connect` renders a compact identity control above Settings in the Harness Web sidebar. ICARUS owns OAuth state, loopback callback validation, and credential storage; the browser client never receives a bearer token.

## Use this package

Mount the client plugin with the Web bundle and mount `@deepseek-ai/dsh-hivemind-runtime` in the Host profile:

```yaml
- insert:
    - id: hivemind-connect
      name: '@deepseek-ai/dsh-client-ui-hivemind-connect'
```

The runtime supplies status, start, and disconnect endpoints. Starting a connection invokes the local ICARUS OAuth flow and accepts no browser-authored identity or callback input.

## Semantics

The client contributes one `sidebar.footer.action` slot. It refreshes connection state after browser focus, polls quickly while login is in progress, and otherwise checks at a bounded interval. A connected state displays the authenticated email plus reconnect and disconnect controls.

The package also contributes the keyed `hivemind_connected_task` tool view. Its durable result projects each bounded Composio operation, including search and connection management, before showing a connection, approval, completion, or failure card. While the Host waits for connection authorization, the same tool view renders the pending interaction inline after its progress rows; the resident composer stays mounted below the transcript. Replay derives settled progress rows from the recorded tool result, while the Session pending-interaction service owns the live authorization controls.

For `hivemind-hyperagents` sessions only, the package adds a composer employee picker and native right-sidebar Preview, Artifacts, Computer, Sources, and Agent tabs. The picker fetches the authenticated tenant roster only when opened, renders the same Humation asset and stable employee-ID seed as the Da-vinci employee avatar, and records a validated selection through the Host session command. The right-side toggle switches between the workbench and Agent tab. The workbench projects only durable generated-artifact, browser-capture, and research-source receipts from the current session, resolving preview images through the session-authorized attachment service. It leaves existing artifact cards and native file viewers intact. Other presets render neither control nor workbench content.

## Model Experience

The model sees nothing from this browser-only plugin. The paired runtime adds authenticated company context and the progressive HIVE-MIND tool after server-side validation. This package adds no prompt tokens and does not affect the model KV cache.

## Known Limitations and Deferred Work

- The control launches locally installed ICARUS and is not a hosted multi-tenant authentication implementation.
- Organization employee discovery belongs to the HIVE-MIND runtime rather than this browser control.

## Dev Note

Keep OAuth callbacks and credential reads in ICARUS or the Host runtime; do not move token handling into browser code.
