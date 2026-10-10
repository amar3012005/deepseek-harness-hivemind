# Agent Note: Explicit summary effort and bounded pressure failure

Status: implemented

English | [中文](2026-10-11-summary-effort-and-failure-budget.zh.md)

## Problem

The main request can select low reasoning while its auxiliary summary omits effort and uses provider defaults. A failed summary can also repeat on every tool step. Neither issue requires removing native tool pairs or saved history.

## Decision

The native summarizer accepts an explicit effort and records it with the summary envelope. Without explicit configuration it inherits only an explicit same-provider/model effort. Company presets select the current Codex route independently of an older conversation header. Failed pressure summaries are attempted once per turn; idle, manual maintenance and confirmed-overflow recovery retain existing retry boundaries.

## Limits

The first provider call still has provider latency. No history deletion or promise of zero feature impact is introduced. Signed reasoning, pending tool pairs, Teams messages, approvals and original events stay governed by existing native compaction; a generated summary can omit details, so original evidence remains retrievable.

## Verification

Focused tests cover effort routing, durable envelope, empty summary rejection, failure retry boundaries, native pairing, cancellation, cold restoration and company preset composition. Real production continuation remains a release-owner check.
