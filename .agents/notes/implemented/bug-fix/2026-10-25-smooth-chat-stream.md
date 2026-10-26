# Agent Note: Settled Assistant text never replays, and live text is paced per frame

Status: implemented

## Problem

A finished Assistant message could re-enter the streaming presentation after a follow reconnect, a window replacement, or a session switch. The stream fold had two replay defects, and live text reached the screen in publication-sized jumps after three animation frames.

Root causes found in the code:

- A reconnect baseline for an attempt whose durable settlement was already in the replacement window reopened that attempt. Its transient chunks were rebuilt beside the settled message. No end frame would ever close the reopened attempt, so the next attempt's start frame forced a rebaseline.
- A follow redelivery of a durable entry already published was published again.
- The conversation assembly flushed streamed updates only after three animation frames, so the first token waited about 50 ms and text arrived in chunk-sized jumps.

Checked and not causes: message bodies have no entrance animation (the mount animations are the turn marks and preview in `TurnNavigator`), context keys are stable (`context.key`), and chat frames travel over the multiplexed WebSocket stream, which HTTP compression does not touch. `text/event-stream` is already excluded from gzip in `packages/host/webserver`.

## Decision

- `ClientAssistantStream.replace` reconstructs a baseline attempt's transient chunks only when the replacement window does not already hold that attempt's settlement. A settlement matches when it is an `assistant/attempt`, or an append-surface `assistant/message`, with `seq` after the attempt's start and the same turn and step.
- `ClientAssistantStream.acceptDurable` publishes a durable sequence at most once.
- `BoundConversation` (`packages/client/ui-conversation/src/client/conversation/assembly.ts`) flushes an `animation-frame` publication immediately after a 100 ms quiet gap, and otherwise coalesces the updates that follow into one animation frame.
- `AssistantMarkdown` paces visible text through `useStreamReveal` (`packages/client/ui-chat/src/client/chat/stream-reveal.ts`). Each frame reveals a quarter of the unshown backlog, clamped to 2 to 200 UTF-16 units. A zero reveal shows the first token at once. Reveal runs only while the message streams, so settled text, reduced motion (`prefers-reduced-motion: reduce`), and platforms without `requestAnimationFrame` show the full text immediately. A stream that starts or resumes begins from the text already present and never replays it. Text is cut without splitting a surrogate pair.
- The Markdown renderer is unchanged. Its incremental parser already re-parses only the unfrozen tail per update.
- Scroll follow is unchanged. The existing pinned-reader logic in `ChatView` already moves the view only while the reader is at the bottom.

## Alternatives considered

**Keep the three-frame publication and pace only in the view.** This leaves the first token about 50 ms late and does not fix replayed transients, so it is rejected.

**Pace text on arrival timestamps.** A fixed delay per chunk reproduces the burst shape of the network and makes bursts look chunky. The per-frame catch-up keeps the lag near 67 ms in steady state and drains a burst within a few frames.

**Use a CSS or DOM animation on the message body.** Animating the body would replay on every remount and is the failure this change removes, so it is rejected.

**Expire the stream on a server-side settlement event only.** The client already receives the settlement, and the defect was in fold order on replacement, so the client-side guard is the smaller fix.

## Consequences

The first token of a live answer appears on the next paint, and text trails the network by about 67 ms in steady state. Each animation frame of a streaming message re-renders its `AssistantMarkdown` once; a completed message renders no per-frame work. A burst of more than 200 units per frame drains over several frames rather than in one jump.

Known gap: a settled message that re-enters the view through an unanticipated path still renders its full text without animation, and the reveal guard confines any residual replay to live text. No live reproduction was run in a browser.

## Verification

- `packages/api/session-controller/tests/assistant-stream.client.spec.ts`: a replacement window that holds the attempt's settlement does not reopen it, and a replayed durable sequence publishes once. Both failed before the fold change.
- `packages/client/ui-conversation/tests/conversation-registry.client.spec.ts`: the first stream update flushes on the leading edge, later updates coalesce into one animation frame, and settlement cancels the pending frame.
- `packages/client/ui-chat/tests/stream-reveal.client.spec.tsx`: cadence, first token, no replay on mount or resume, settled and reduced-motion immediacy, and surrogate-safe cuts.
- `packages/client/ui-chat/tests/chat-view.client.spec.tsx`: the streamed-tail assertion waits for the paced reveal, and the sibling tool-row identity check still holds.
