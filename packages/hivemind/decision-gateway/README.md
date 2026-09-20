# HIVE-MIND decision gateway

English | [中文](README.zh.md)

This Cordis plugin consumes Core's bounded decision contract before the first
model request of a turn. In active mode it narrows the inherited tool surface
to the selected HIVE or connected-app gateway. It never plans, generates tool
arguments, authorizes, or executes work.

Any timeout, transport failure, invalid response, low-confidence Core defer,
or unavailable selected tool preserves the existing Harness tool surface in
the same turn. Shadow mode records decisions without changing tools. Off mode
does no work.

The restriction is lifted before a continuation step or the next turn, so the
current Harness selector remains the fallback and owns all later progression.

## Model Experience

- **Visible tools:** no new tool; active mode narrows the first request to one
  existing gateway tool or to no tool for a direct answer.
- **Prompt cost:** no added prompt text; the ordinary request header records
  the selected tool surface.
- **KV-cache effect:** the stable system prefix is unchanged.

## Known Limitations and Deferred Work

Only the first admitted user message is narrowed in this version. Continuation
steps intentionally return to the current Harness selector until per-stage
Composio and HIVE-meta consumers adopt the same Core contract.

No runtime invariant companion is published; the plugin owns no authorization
or execution state, and its temporary scoped restriction is covered by focused
lifecycle tests while request headers remain the authoritative model-surface
record.
