# Mobile chat refinement

## Scope

Phone native Brain and employee presentation uses one composer geometry, preserving the existing native editor, plus sheet, connector sheet and voice/send/stop slots. Tablet and desktop retain their existing layout. The overlapping phone rules previously hid the connector and re-enabled dictation; this change consolidates them.

## Reading and touch behavior

The toolbar overlays history as individual controls, with initial content and scroll clearance instead of an opaque header strip. The bottom composer seat stays sticky and transparent around its input card. Touch chat activation does not automatically focus the editor, so opening an existing room does not summon the keyboard. Tapping the editor still works and persisted drafts use the same native owner. Readable replies have a 16px minimum and retain larger configured text. Wide code/media stay within the message column; media is centered. Streaming uses existing keyed native nodes; no per-token animation or second stream is added.

The composer consumes theme elevation/focus tokens and confines translucency to controls. Native/browser accessibility hints disable transparency and pending animation. The Android 48px target override remains intact.

## Verification boundary

Focused mobile sheet, rendering and scope checks passed (105); host build, client compilation and the two modified bundles passed. The iPhone 18 Pro Max simulator is signed in for visual verification. Production activation and tactile/real microphone verification are separate from source/build success.

The final input/scope checks passed (22), including intentional touch focus. The full GUI run had 40 failures, 6362 passes, 5 skips and two errors; unchanged HEAD reproduced 40 failures, 6361 passes, 5 skips and two errors. These baseline failures remain unresolved; the extra passing test is the new touch-focus regression. Simulator authentication and real Runtime history were verified on the currently deployed chat graph, which does not yet contain this client refinement.

Sources: Apple HIG materials, accessibility, motion and text fields; local Apple docs MCP notes. CSS backdrop blur in WKWebView is an approximation, not native Liquid Glass.

Phone Session opening now requests five recent turns through the existing maxTurns contract; desktop retains twenty and earlier-page cursors/order are unchanged. Current fork source supplies this contract; the indexed upstream DSH documentation revision predates it. The phone/default window and session/input checks passed (75). No database or alternative history stream was introduced.
