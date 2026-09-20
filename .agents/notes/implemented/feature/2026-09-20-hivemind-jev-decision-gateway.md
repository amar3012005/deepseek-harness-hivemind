# Agent Note: HIVE-MIND Jev decision gateway

Status: implemented

English | [中文](2026-09-20-hivemind-jev-decision-gateway.zh.md)

## Problem

HIVE chat exposes stable HIVE memory and connected-app gateways, but the chat
model previously received both schemas before it knew which capability the
request needed. Using the chat model itself as a preliminary selector repeats
prompt and schema cost. Replacing the Harness loop with a workflow planner
would sacrifice its progressive, receipt-driven behavior and create a second
execution authority.

## Decision

The HIVE chat preset mounts `@deepseek-ai/dsh-hivemind-decision-gateway` after
the HIVE memory and connected-app tools. The plugin calls the authenticated
Core decision endpoint during `agent/pre-step`, before prompt and tool
assembly.

It is not a planner. It selects only the first capability family for the
admitted user message. Active mode applies a scoped Cordis tool restriction
for that model request; shadow mode only records the decision; off mode
registers no listener. The restriction is lifted on the next pre-step.

Core owns provider credentials, confidence and margin thresholds, and the
typed Jev contract. The runner sends no tenant identifiers; its short-lived
service token supplies identity at Core. Provider errors, timeouts, invalid
responses, low confidence, missing selected tools, and Core defers leave the
existing Harness tool surface untouched in the same turn.

The decision is appended as `hivemind/decision`. The exact model-visible tool
surface remains reconstructable through the ordinary request header. Tool
arguments, authorization, approvals, execution, receipts, and continuation
remain owned by their existing plugins and the unchanged agent loop.

## Alternatives considered

**A deterministic DAG planner.** Rejected because it would duplicate the
Harness model's progressive control of dependent steps and make a second
component responsible for workflow ordering.

**Calling Jev directly from each runtime.** Rejected because it would duplicate
provider credentials, thresholds, and result validation in Legacy and the
runner. Core is the single provider boundary.

**Changing the agent loop.** Rejected because Cordis already provides the
scoped `agent/pre-step` and tool-restriction seams. A loop patch would couple
the optimization to every Harness profile.

## Consequences

The first model request can carry only the selected existing gateway schema,
while the ordinary selector remains the immediate fallback. Shadow rollout is
possible without changing model-visible behavior. The trade-off is one bounded
decision request before the first model call, and continuation steps currently
return to the full existing selector until later stage consumers adopt the
same typed Core contract.
