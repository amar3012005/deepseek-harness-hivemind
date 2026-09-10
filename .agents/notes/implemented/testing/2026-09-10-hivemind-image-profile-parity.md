# Agent Note: HIVE runner image owns resolved-profile parity

Status: implemented

English | [中文](2026-09-10-hivemind-image-profile-parity.zh.md)

## Problem

Source-plane tests can resolve workspace packages through TypeScript paths even when the runner image lacks a package needed by the `hivemind-chat` preset. A partial browser-asset layer also allowed a native rendering package to be disabled without proving that the final image preserved the full Web composition.

## Decision

`deploy/hivemind-chat/Dockerfile` is the only HIVE runner image recipe. It builds the complete workspace graph and materializes each `@deepseek-ai` workspace link under the image installation. The retired `Dockerfile.frontend-runtime` no longer overlays selected client artifacts on a different backend image.

`deploy/hivemind-chat/verify-image.sh` runs the compiled CLI and preset registry inside the built image. Its probe requires the native presentation rows for Markdown, tables, code, math, reasoning, tools, trajectory, attachments, jobs, subagents, and replay to remain enabled. It also resolves the `hivemind-chat` preset and connected-apps package from the image filesystem.

## Alternatives considered

**Source-only profile tests.** Rejected because source resolution can conceal an absent image dependency.

**A frontend-only overlay image.** Rejected because copying selected build artifacts creates a second package graph that can drift from the server and preset resolver.

**Removing native browser renderers for HIVE.** Rejected because HIVE mode is a reversible composition overlay and must retain native conversation presentation.

## Consequences

The runner artifact is larger than a client-only image but carries one coherent package graph. The profile probe validates profile and preset installation only; authenticated session admission, persistence, and browser transport remain integration acceptance owned by their respective services.
