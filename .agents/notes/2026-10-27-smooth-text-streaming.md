# Smooth Assistant text streaming

Status: implemented

## Finding

A production Runtime room showed a 699-character answer in one DOM update, 9.4 s into a turn whose model had streamed it. The pipeline before the browser delivers every delta: the bridge writes one NDJSON `text-delta` per provider delta, `CloudCodexAdapter` yields each chunk, the agent loop publishes one `assistant-stream` frame per chunk (the same chunks that land in the durable `stream` of `assistant/message`, so model-visible text stays logged), the Session follow journal forwards the frames, and the Client Session turns each into an `assistant/live-chunk`. `sessions-service.client.spec.ts` now asserts one event-source update per forwarded delta before the settlement.

The loss was in the browser, in three rAF-only stages:

1. Two reveal stages were stacked in `AssistantMarkdown`: `useStreamReveal` (upstream) and `StreamingMarkdown` (a 50 chars/s pacer added for HIVE). The second stage re-ran its effect on every change of the first stage's output, which cancelled its pending frame. It trailed the network by a growing margin (59 of 240 characters visible after 1.2 s of 200 chars/s input) and revealed the rest when streaming ended.
2. The Conversation assembly published coalesced stream updates only from `requestAnimationFrame`. A background tab or busy renderer defers frames indefinitely, so only immediate updates (status lines) reached the DOM until completion. The Session notifier already had a timer fallback; this stage did not.
3. `useStreamReveal` advanced only on animation frames for the same reason.

## Decision

One pacer. `stream-reveal.ts` reveals about three characters per frame and raises the rate with the backlog (backlog divided by a third of 300 ms), so the display stays near 100 to 300 ms behind. The first characters appear in the commit that receives them. Frames come from `requestAnimationFrame` with a 50 ms timer behind it. A finished message, a hidden tab (including a tab that turns hidden mid-stream), and `prefers-reduced-motion` show the whole text at once. `StreamingMarkdown` is removed, and the Conversation assembly gets the same timer fallback. Markdown still goes through `MarkdownText`, whose incremental parser freezes completed blocks.

## Rejected

Sentence or word buffering: it adds a visible stall and the pacer already bounds the lag. Pacing in the Session store: stored events stay exactly as received; presentation timing belongs to the renderer.

## Snapshot impact

No recorded-session snapshot changes: no event, tool, or model-visible text changed. Both SDK projections are unaffected.
