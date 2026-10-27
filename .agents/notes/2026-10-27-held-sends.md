# Held sends and plain send errors

Status: implemented

## Decision

A prompt that fails because the Host is unreachable or restarting is held, not reported. `isUnreachableSendFailure` treats `gateway/internal`, `gateway/unavailable`, `gateway/timeout`, `transport/unavailable` and transport, HTTP 5xx, socket, network and connection-loss messages as unreachable. The Session puts the prompt in its `SendOutbox` under the submission's original `requestId`, keeps the optimistic echo, and retries at 1, 2, 4, 8 and then every 15 s until the Host accepts or rejects it. The Host deduplicates prompts by `requestId` (`hasPromptRequest`), so a resend after an unseen acceptance never adds a second message. The snapshot's `heldSends` counts held prompts while history is open, and the composer shows the locale-owned "Reconnecting… your message will send" line.

Every other prompt or stop failure shows one plain locale-owned sentence. A send failure also shows a Retry button above the composer while the draft is kept; attachment rejections keep their reason-specific copy. Raw RPC messages and codes are no longer shown.

## Rejected

Retrying every failure was rejected: a validation rejection would loop forever. Showing the raw message for developers was rejected; the code stays in the snapshot for diagnostics.
