# Brain room parity with the Runtime room

The Brain room (`/hivemind/app/overview`) takes the Runtime room's composer and bubble values, its phone header controls, and its model-picker phone rules. The room root sets `data-brain-room`, and the composer rules are keyed on it. The Runtime rules are copied from `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` (OpenDot values, phone and desktop), with the `[data-agent-room]` and `[data-native-chat]` selectors rekeyed to `[data-brain-room]`. Plan and Read-only stay visible in the composer because Brain has no `+` sheet to reopen them.

Phone user bubbles use 9px 14px padding and radius 20. The model picker shows the name and chevron only. Work details folds carry `data-work-details` and hide on phones under the Brain room; a turn's error row stays visible.

Not ported: the assistant bubble frame (Brain's assistant markup has no `data-assistant-text`), the Runtime `+` attach/access sheet, and the Runtime identity pill (Brain shows the shell's centred Company Brain pill). Composer glass uses the `--dsw-alias-bg-base` token through `color-mix`; the OpenDot shadow values stay literal.

Prompts sent while the subscription opens are held in the send outbox under their echo's requestId and flushed on open (see `2026-10-25-send-outbox-exactly-once.md`). Session-list SWR caching is described in `2026-10-25-swr-room-cache.md`. Composer drafts typed before attach are described in `2026-10-25-instant-composer-pending-draft.md`.

Acceptance: `pnpm run typecheck:contracts-ready` passes. The focused client suites for ui-chat, ui-conversation, ui-hivemind-connect, session-controller, and ui-model-selection pass except nine tests that fail identically on the base commit (`session-projections.host.spec.ts`, `hive-composer-layout-styles.client.spec.ts`, `browser-plugin.client.spec.tsx`, `dreaming-settings.client.spec.tsx`, `hyperagent-employee.client.spec.ts`, `hyperagent-preview.client.spec.tsx`). Screenshot comparison against Runtime was not run because the browser pane was not signed in.
