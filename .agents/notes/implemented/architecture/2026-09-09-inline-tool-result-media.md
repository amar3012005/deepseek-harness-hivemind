# Agent Note: Tool-result media renders from the native content contract

Status: implemented

English | [中文](2026-09-09-inline-tool-result-media.zh.md)

## Problem

The MCP bridge already persisted screenshot bytes as durable image attachment references in `tool/result`. Chat could load those references, but only the keyed `read_image` Tool view rendered a gallery. Browser screenshots and future image-generation tools therefore exposed the attachment inside the expandable generic receipt without showing the media inline.

## Decision

The Tool call tree derives ordered image references from every successful result's native content blocks. It renders them below the unchanged Tool row through the Cordis child slot `tool.call.inline-images`. The attachment presentation plugin fills that slot with the existing Session-authorized gallery and lightbox.

Routing is based only on the durable content shape. It does not match Playwright, MCP, or image-generator tool names. A malformed image block refuses the complete inline gallery, and failed Tool results never render inline media; their canonical receipt remains visible.

The specialized `read_image` expanded card retains its existing `tool.call.images` gallery. Inline presentation adds a direct transcript view without replacing the Tool lifecycle, result, metadata, inspection affordance, or model-visible content.

## Alternatives considered

- **Register each media-producing tool name** — rejected because providers and tool catalogs evolve independently from the Client renderer.
- **Copy remote image URLs into React state** — rejected because UI state is not durable, replay-authorized, or tenant scoped.
- **Rewrite the assistant's final response to include the image** — rejected because it fabricates model output and duplicates the authoritative Tool result.

## Consequences

- MCP screenshots and future tools using native durable image blocks render inline automatically.
- The existing attachment store, Session authorization, URL lifetime, gallery layout, and lightbox remain the only byte-loading path.
- Text-only results, failures, and malformed legacy records retain the existing Tool UI.

## Verification

- `packages/client/ui-tool/tests/tool-call-tree.client.spec.tsx` covers arbitrary-tool inline projection and refusal of failed or malformed results.
- `packages/client/ui-attachment/tests/plugin.client.spec.ts` covers registration and disposal of the new Cordis slot entry.
- The existing image-card and attachment suites preserve specialized rendering, replay loading, and lightbox behavior.
