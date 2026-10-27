# Agent Note: Each independent page-load read runs once

Status: implemented

## Problem

A Brain page load read the same catalogs more than once within a few seconds: `agentPresets.list` for the chip, the header label and the settings section; `commands/list` and `messageFeedback/list` again on the first `connection/reset`; `subagents/list` on selecting a Session and again on opening its catalog menu; and the bootstrap identity probe once per browser account cache.

## Decision

- `ui-agent-preset`: `readRoster` shares one answer for 4 s per context; a settings edit, an authored preset, a section write and a non-initial reconnect read fresh.
- `ui-commands` and `ui-message-feedback` honor the `initial` flag of `connection/reset`: a read that is pending or answered keeps its answer.
- `SessionManager.select`, `selectSubagent` and catalog menu open read a catalog only when its answer is older than 4 s; membership frames and reconnects always read.
- `createBrowserAccountCache` shares one bootstrap probe per page.

## Alternatives considered

- Coalesce every identical Remote call in the gateway. Rejected: it cannot tell a read from a state change and hides which owner repeats.
- Cache answers without invalidation by room events. Rejected: a live event inside the window would show stale state.

## Consequences

- A request that moves state, a live event or a real reconnect still reads fresh; staleness is bounded by 4 s only for mount-time reads.
- Runtime-only readers (`RuntimeTour`, awakening gate, HQ workspace) of the same change in the Runtime lineage do not exist in Brain and are not ported.
