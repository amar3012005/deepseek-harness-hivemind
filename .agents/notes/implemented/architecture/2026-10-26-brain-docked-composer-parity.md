# Brain chat composer docked in every phase

Brain chat (`/hivemind/app/overview`, `/new`, `/session/<id>`) sets `data-brain-chat` on the conversation root. In the hero phase, its composer stays at the column floor, as in the Runtime room. The greeting (`.heroIntroduction`) takes the free space above the composer and scrolls with the column. The settling and active phases use the same seat, so the first message does not move the composer.

The Brain root also keeps `data-brain-room`, which remains the key for the Brain-only header and environment rules. Runtime's centred desktop hero is not reproduced: the requirement asked for the floor docking on desktop too.

The read-scope selector (`conversation.hero.scope`) renders inside a `.heroScope` wrapper. The wrapper is hidden while empty. On Brain phones the row copy is hidden and the selector is offered to the `+` sheet through the `heroScope` composer owner prop, so it is never a blank bar.

The `+` sheet (`MobileAddSheet`) replaces the command menu on Brain phones. It holds attachments, Search and Deep research, connected sources, and the chat options (access, plan, model). The desktop row keeps those seats. Sheet copy is locale-owned (`mobileAdd.*`) and colours use theme tokens.

Assistant text carries `data-assistant-text`; the phone frame is keyed on `[data-brain-chat]`.

Not ported: the Runtime identity pill. The centred Company Brain pill is rendered by the outer HIVE shell, whose header is hidden on Brain phones, so it is outside this package set.

Acceptance: `pnpm run typecheck` passes. `ui-conversation` and `ui-chat` suites pass (806 tests). Seven `ui-hivemind-connect` tests fail identically on the base commit (`browser-plugin`, `dreaming-settings`, `hyperagent-employee`, `hyperagent-preview`). The layout test that asserted `headerUtilities` with `display: flex` was stale; the live CSS hides utilities in embedded mode and the assertion now matches that rule. Browser comparison against Runtime was not run.
