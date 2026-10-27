# Agent Note: Room data starts over HTTP, not after the push stream

Status: implemented

## Problem

Production page loads on 27 Oct 2026 showed a dead gap of about 20 s with no API request, then waves of repeated requests. The Session list pull started only inside `handleConnected`, which runs on `connection/reset`, after the event stream's ready frame. Every catalog that loaded on construction (model catalog, agent roster, schedules, Models page) was then reset and read again by the first `connection/reset`. A failed or slow generation called `streams.reconnect()`, which closed a healthy or still-connecting WebSocket and restarted every logical stream open. Boot and appearance reads were repeated by each mounted component. Room status read `connection.state`, which stays `connecting` while the room's own event stream already delivers events.

## Decision

- `session-controller` starts the list pull at apply. The first `handleConnected` keeps a pull in flight and a subagent catalog already read.
- `connection/reset(initial)` marks the first generation. Model catalog, agent roster, Models page, schedule catalogs keep a read that is loading or answered; a failed read reloads.
- `onReconnectRequested(replacePhysical)`: an automatic retry keeps an open or connecting WebSocket. Manual reconnect, a browser network change and a missed hard readiness deadline replace it.
- Boot probe, Runtime appearance reads and model-connection status are shared per 30 s, 10 s and 10 s windows. A committed appearance save clears its window.
- A live `turn/start` or `turn/end` on a Session's own stream updates its running bit. Room `stale` and Runtime motion count an open room stream as live.
- The chat hint "Loading history" shows only while no entry is rendered, so a cached tail is not hidden.
- `prefetchHistory` writes the newest page of up to 12 listed rooms (2 requests at once) to the local history copy; the pointer or focus on a rail row moves that room first.

## Alternatives considered

- Raise `generationReadyTimeoutMs`. Rejected: the observed failure is not the deadline, and a longer deadline only delays recovery of a real stall.
- Treat any mux frame as `connected`. Rejected: `connected` promises that Remote events are attached.

## Consequences

- A slow Host no longer restarts all streams. A stalled carrier is still replaced after the readiness deadline.
- A shell that pins `connection/reset` listeners to `() => void` still works; the argument is optional.
