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

## Model Experience

The model sees nothing from this browser-only plugin. The paired runtime adds authenticated company context and the progressive HIVE-MIND tool after server-side validation. This package adds no prompt tokens and does not affect the model KV cache.

## Known Limitations and Deferred Work

- The control launches locally installed ICARUS and is not a hosted multi-tenant authentication implementation.
- Organization employee discovery belongs to the HIVE-MIND runtime rather than this browser control.

## Dev Note

Keep OAuth callbacks and credential reads in ICARUS or the Host runtime; do not move token handling into browser code.
