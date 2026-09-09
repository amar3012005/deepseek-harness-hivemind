# Agent Note: MCP transport recovery retries only declared read operations

Status: implemented

English | [中文](2026-09-09-mcp-read-only-transport-retry.zh.md)

## Problem

A Streamable HTTP MCP endpoint can lose its protocol session or return a transient 502, 503, or 504 response while its service remains healthy. Rotating the failed client repaired later calls, but the active Harness tool execution still failed. Replaying every call would risk repeating an external write whose first outcome was unknown.

## Decision

The MCP connection supervisor owns protocol-generation replacement. On a recoverable transport failure, it closes the failed client, reconnects through the existing bounded policy, synchronizes the server tool generation, and gives waiting callers the connected client.

The bridge repeats the original wire request once only when the server advertised `annotations.readOnlyHint: true` for that tool. Unannotated and write-capable tools are never replayed; their failed generation is still rotated for later calls. A failed retry also rotates its client for later work but terminates the active execution. Cancellation, reconnect exhaustion, disabled reconnection, and plugin disposal settle waiting calls with errors.

Both wire attempts belong to one Harness tool execution. The existing durable tool events, result mapping, policy waterfalls, and UI card remain unchanged.

## Alternatives considered

- **Retry every transient transport failure** — rejected because the remote operation may have completed before the response was lost, so replay can duplicate writes.
- **Match safe tools by name** — rejected because names are deployment-specific and do not express MCP operation semantics.
- **Leave recovery to a later model step** — rejected because it exposes a recoverable read outage to the model and spends another model request on transport repair.

## Consequences

- Explicitly read-only MCP tools tolerate one lost Streamable HTTP generation without adding another model step.
- Servers that omit `readOnlyHint` receive conservative behavior: connection repair for later calls and no automatic replay.
- The retry adds no tool schema, prompt text, session event, or mode-specific behavior.

## Verification

- `packages/mcp/mcp-client/tests/reconnect.spec.ts` covers successful read-only retry, unannotated non-retry, generation replacement, and existing reconnect lifecycle behavior.
- `packages/mcp/mcp-client/tests/mcp-client.spec.ts` preserves native result and attachment projections.
