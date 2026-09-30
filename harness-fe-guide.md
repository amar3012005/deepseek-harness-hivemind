# Harness FE guide

Start here for native Harness UI changes. This guide maps the runner's frontend only; the outer HIVE site is a separate frontend. Native UI is compiled into the `harness-runner` image by `deploy/hivemind-chat/Dockerfile`.

| Need to change | File | Main functions / responsibility |
| --- | --- | --- |
| Embedded route and session restoration | `packages/client/ui-hivemind-connect/src/client/session-route.ts` | `HIVE_OVERVIEW_PATH`, `HIVE_EMPLOYEE_HARNESS_PATH`; maps BRAIN and OS URLs to native session IDs and creates a session for `/new`. |
| HIVE integration and slot wiring | `packages/client/ui-hivemind-connect/src/client/index.ts` | `apply`; auth/bootstrap, employee picker, Preview toggle, right pane, HIVE-specific slot registrations. |
| App columns and native session rail | `packages/client/ui-layout/src/client/AppFrame.tsx` and `AppFrame.module.css` | `AppFrame`, `CenterColumn`, `RightbarColumn`; grid, drag handles, session rail seat, Preview column. |
| Transcript and composer | `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx` and `ConversationRoot.module.css` | `ConversationRoot`, `WidthHandle`; content width, composer seat, hero/active positioning, scroll area. The CSS owns native alignment in both BRAIN and OS. |
| Session header and top-right controls | `packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx` and `ConversationRoot.module.css` | `ConversationSessionHeader`, `ConversationSession`; header utility and corner slots, view tabs, blank-session visibility. |
| Past sessions in both modes | `packages/client/ui-workspace/src/client/HiveSessionProjection.tsx` and `.module.css` | `HiveSessionProjection`, `sessionTimestamp`; reads real session summaries, filters by preset, renders BRAIN rail or portals into the existing OS sidebar, creates/opens/renames/deletes sessions. |
| Session row and menu | `packages/client/ui-workspace/src/client/rows/Rows.tsx` | `SessionNodeItem`; row title, timestamp, selected state and action menu. |
| Environment card and Preview button | `packages/client/ui-hivemind-connect/src/client/HyperagentEmployee.tsx` and `.module.css` | `HyperagentPanelToggle`, `HyperagentEmployeePanel`, `HyperagentEmployeePicker`; floating Environment card, collision collapse, Preview pane, employee picker. |
| Schedule icon and task UI | `packages/client/ui-schedule/src/client/ScheduleManagerAction.tsx`, `ScheduleCatalogAction.tsx`, `TaskManagerPage.tsx`, `index.ts` | `ScheduleManagerAction` opens the manager; `ScheduleCatalogAction` shows active session tasks; `TaskManagerPage` lists retained tasks; `apply` registers header and sidebar slots. |
| Schedule eligibility and cold wake | `packages/hivemind/schedule-postgres/src/index.ts` | `allowsAgent`, `dispatch`, `table`; tenant-scoped PostgreSQL schedule storage, allowed presets, due-session restore. |
| Bundle profile | `packages/bundle/hivemind-web-app/cordis.patch.yml` | Enables the native client and PostgreSQL Schedule plugins used by the runner. |

## Fast path

1. Decide whether the change belongs to the runner. BRAIN and OS native chat/Preview/Schedule do. The outer navigation shell and VOICE page do not.
2. Edit the one owner above. For BRAIN/OS differences, use the pathname and the session's `agentPreset`; use the durable list-row preset for cold sessions and keep lists mode-filtered.
3. For local iteration, use `pnpm dsh web --patch packages/bundle/hivemind-web-app/cordis.patch.yml`. If enabling a development-only `@deepseek-ai/dsh-hmr` entry, also mount its logger exporter and timer provider. HMR then reloads changed plugins and diffs `cordis.yml` entries by stable `id`; a missing injected service leaves a plugin PENDING. Check the browser after each change. The production image does not run HMR.
4. Run focused package tests and TypeScript checks, then `pnpm run build`. The production deploy unit is one cached `linux/amd64` runner image from an exact pushed SHA. Verify it with `deploy/hivemind-chat/verify-image.sh`, replace only `harness-runner`, and check the authenticated route. Use `deploy/hivemind-chat/NEW_MAC_HYPERAGENTS_HANDOFF.md` for the current versioned Compose and rollback steps.
