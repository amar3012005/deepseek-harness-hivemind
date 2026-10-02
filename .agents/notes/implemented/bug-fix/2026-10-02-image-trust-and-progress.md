# Agent Note: Image transport trust and progress

Status: implemented

English | [中文](2026-10-02-image-trust-and-progress.zh.md)

## Problem

The native image worker could not trust the outbound TLS certificate. Connection retries hid the failure until a runner restart interrupted its pending turn. Media cards had no visual generation feedback.

## Decision

The release installs the system CA bundle and supplies it to the private Codex worker, preserving certificate verification and explicit configured CA paths. Connection retries are bounded and use HTTPS streaming. Active image cards use the requested img-fx pixel animation with an elapsed-time estimate capped below completion. Only confirmed artifact receipts represent completion.

## Alternatives considered

**Disable TLS verification.** Rejected because it removes server authentication.

**Present elapsed time as actual provider progress.** Rejected because the image provider does not report a percentage.

## Consequences

The frontend respects reduced motion and falls back if WebGL fails. Native local jobs still do not survive runner restarts; unknown outcomes require reconciliation instead of blind regeneration. Build and health checks do not establish a successful image-generation receipt.
