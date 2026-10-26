# Instant composer with a pending draft buffer

The composer accepts typing for a known room before its Session input machine attaches. The typed text lives in a per-Session in-memory buffer (`ui-conversation/src/client/skeleton/pending-draft.ts`). When the machine attaches, `InputBar` hands the buffer to the machine once, merging it after any draft the machine already holds, so neither is lost. Send and the model seat stay disabled until the machine is live, so buffered text cannot be submitted twice; exactly-once send through a pre-open outbox is a separate follow-up.

The pre-attach input is a plain textarea. It becomes the editor element when the machine attaches, and focus moves with that swap. Typing is allowed only when the Session is not inert (a workspace title is known), not removed, not blocked, and its parent is available for a continuable child.

Acceptance: `packages/client/ui-conversation/tests/pending-draft.client.spec.ts` covers per-Session isolation, one-time take, subscriber notification, and the three handoff merge cases. The full ui-conversation client suite passes (38 files, 451 tests).

Not yet measured: the 375 px and desktop composer-visible timings on the production Runtime room. The baseline and the timed before/after comparison are part of the follow-up rollout record.

The Da-vinci host shell hands over a draft with a `hm:composer-draft` window message on the same document: `{type, roomId, text}`, where `roomId` is `runtime` on employee rooms and `brain` on Brain routes. `hostDraftRoomKey` maps the route to that key. The listener adopts the text into the buffer once, only when the buffer and the machine draft are both empty, and rejects other origins. Parent origins come from the `hostDraftParentOrigins` Config field (exact origins only, validated at apply; production sets `https://next.singulancelabs.com` in the HIVE bundle patch). The host clears its own sessionStorage draft key; this client does not read or write it.
