# Agent Note: HIVE Chat progressive kernel

Status: proposed

## Problem

HIVE Chat sends a broad policy prompt, long replay window, and routine process disclosure before it knows whether a user needs company recall, an artifact, connected-app work, or a simple answer. This increases model input and makes the product present implementation activity as conversation.

## Proposal

The HIVE Chat preset keeps its existing tenant-scoped identity, memory, connected-app, artifact-renderer, session, and approval services. Its model-facing persona becomes a compact company-brain kernel. Detailed memory governance, company research, and artifact-delivery instructions become opt-in skills discovered through the existing filesystem provider and loaded through the existing skill tool only for a matching request. Connected-app workflow guidance remains in its existing opt-in skill.

The working replay is three turns and 3,000 characters. The HIVE Chat UI suppresses the generic turn-process control; pending work remains represented by the product activity indicator while durable session records retain diagnostics.

## Alternatives considered

**Replace the HIVE runner with the migration branch.** Rejected because it would require revalidating HIVE rendering, connected apps, tenancy, and persistence while retaining a large base persona and an unresolved toolkit mount dependency.

**Remove HIVE services from the preset.** Rejected because service residency preserves authenticated capabilities without requiring their detailed instructions in every model request.

**Change the native agent loop.** Rejected because presets, skill discovery, and the chat renderer are existing native extension seams and do not require loop changes.

## Acceptance criteria

- A fresh HIVE Chat request has the compact persona, three-turn replay, and no routine progress instruction.
- Company recall, memory mutation, research, connected-app work, and artifact work load their detailed instruction only when invoked.
- The HIVE Chat route has no generic Work details or Thinking control.
- Tenant-scoped services, native approval, artifact delivery, and connected-app behavior remain available.
- A signed-in canary records provider input tokens, first answer text, tool timings, final completion, and rollback evidence before release.

## Risks

A compact kernel can omit a specialized safety or workflow rule if the matching skill is not loaded. The release therefore needs behavior coverage for memory writes, connected-app writes, external research, and artifact delivery. The present client records first token and final completion; a full request-size and first-answer trace remains a separate telemetry addition.
