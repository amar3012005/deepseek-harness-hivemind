# Agent Note: Deduplicate connected workflow context on the session surface

Status: implemented

## Problem

The connected-app plugin reconstructs workflow and receipt projections at each `agent/pre-step`. The agent loop appends accepted pre-step messages to the durable user-message surface, so identical projections from later steps and turns repeated the same evidence and instructions in model history.

## Decision

Before adding a workflow or receipt projection, the plugin checks the current derived session messages. It reuses an identical visible projection and adds a new one only when the evidence changes or a surface rewrite removes the prior projection. If a tool result already contains the durable receipt identifier, that result is sufficient context and the duplicate receipt projection is skipped.

Requested execution fields now carry `projection_status: "complete"` or `"incomplete"`; the connected-task tool description directs the model to report missing fields and not overstate an incomplete projection.

## Alternatives considered

**Inject the latest receipt on every step.** This is what the prior implementation did; because pre-step messages are appended to session history, unchanged instructions and receipt data accumulated in the transcript.

**Remove durable receipt projections entirely.** This avoids duplicate context but loses a compact recovery path when the surface no longer contains a tool result after history compaction.

## Consequences

The append-only session surface remains the source of visible model context, and private receipts remain available for audit and recovery. Changed workflow state can add a new projection while identical state does not. A requested field absent from a provider response is represented as incomplete without changing the provider operation's execution status.
