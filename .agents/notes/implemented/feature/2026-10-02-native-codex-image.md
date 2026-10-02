# Agent Note: Native Codex image generation

Status: implemented

English | [中文](2026-10-02-native-codex-image.zh.md)

## Problem

Native image generation was not connected to the shared media registry. Attachment-only generation and interrupted operation recovery needed durable handling.

## Decision

Both presets mount one shared renderer. An image-specific Codex app-server adapter resolves protected OAuth credentials through a host-only event, consumes native image receipts, and validates private output files. Session intent is flushed before dispatch. Stable operation identities reuse saved output or reconcile the recorded thread; unknown outcomes stop without regeneration. Exact files and previews remain native attachments.

## Alternatives considered

**Plan-sharing Responses images.** Rejected because that route excludes image generation.

**Automatic paid API fallback.** Rejected because it changes billing without an explicit configuration choice.

## Consequences

No agent-loop change or browser credential exposure is required. Existing web-search selection is preserved. Native jobs do not survive runner restarts; explicit reconciliation uses durable operation state. Compilation and runtime health do not prove account-level image generation.
