# Official alpha.2 compatibility and coordination audit

## Exact baselines

- Production image reported by release owner: `hivemind/harness-chat:sha-130f01b8f3-fresh-greetings-status`, source `130f01b8f3f99c72012862d5a2ea60575e57e77b`.
- This task starts from `870878bbd76c9c81e8b7f511b82d9cbf9468f59c`, preserving the newer reset repair.
- Official immutable annotated release tag `dsh-v0.2.1-alpha.2` resolves to `d743267388641bc76f17c45ce8b4c231aed1d32c`.
- Official notes: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2
- MCP documentation currently reports revision `639ed015397290b3745d163aafe02ffee4aa3f84`; it is not the tagged release source.
- The current production commit does not contain the tagged release commit. Package/root manifests still say `0.1.5-alpha.2`; this alone is not ancestry proof, but direct source inspection confirms the legacy Team mailbox is still present.
- Tagged source was fetched into a separate shallow clone to avoid corrupt-object/delta failures fetching upstream directly into the customized checkout. A shallow history cannot establish the precise common fork point. Do not claim the whole deployed runner is upgraded to alpha.2.

## Native compatibility map

| Area | Official alpha.2 contract | Current customized runner | Required upgrade boundary |
| --- | --- | --- | --- |
| Agent Teams delivery | Direct target Inbox; `sendMessage` returns accepted `messageId`; upstream automatic outbox/retry/dedup removed | `TeamMailbox` still queues and checkpoints messages; persistent-assignee extensions are company specific | Preserve persistent assignees/task guards while migrating this facade and every caller/result shape together; do not replace only one file |
| Company room delivery | Ordinary native Agent Inbox admission remains owner | `RoomMessaging` already uses `target.steer` with durable sender and receiver receipts | Keep tenant ownership and company retry/dedup outside assumptions about native Team automatic delivery |
| Subagent completion | Child ID returned immediately; custom SDK must support `session/wait` | Customized older subagent services and guarded persistent employee rooms | Audit child-host callers and wait contracts as one migration; persistent employee rooms are not interchangeable with temporary children |
| Stream stalls | Idle deadline must terminate even when transport ignores cancellation | Current pi-ai adapter has an idle-timeout implementation; tagged DeepSeek adapter has changed substantially | Compare provider-specific request/abort behavior; version labels alone do not prove all provider paths have this repair |
| Lifecycle/resource teardown | Native shutdown and watchers retain correct dependency lifetime | Customized older agent-loop/lifecycle code | Adopt with dependency graph and cancellation regression coverage, preserving saved questions and company work |
| Work state UI | Waiting/streaming/retrying workflows must not be marked complete | Company task acceptance already requires Runtime current-revision review; custom sidebar projections exist | Preserve accepted-review gate, map native status accurately, and verify cold restoration |

## Implemented bounded company recovery

The sender queue now retains its original delivery key, exact target and authenticated initiator. On an admitted sender turn, at most eight unconfirmed saved packets are retried through the existing RoomMessaging/Inbox owner. The fresh directory must still authorize the employee; paused, archived or missing recipients are excluded. Completed/deleted/reassigned HQ task packets are not replayed. Historical explicit packets can be reconstructed only from a saved matching tool call, never by inventing a key or guessing an identity. Receiver receipts and native pending Inbox prevent duplicate admission. This is not a background polling loop and does not fabricate a colleague reply or a human approval.

## Evidence and limits

Focused tests cover native fresh/cold Inbox blocker disclosure, saved pause checkpoints, verified connection/input resumption with the same employee and task, changed-authority rejection, current-revision review acceptance, bounded packet retries, receiver-flush failure, duplicate admission, and preservation of original sender identity.

These checks establish component behavior. They do not prove a complete live Slack event, real employee output, Runtime accepted review and delivered notification on the final combined deployment. The release owner must verify that chain, plus restart recovery, on the exact integrated image before claiming end-to-end completion. No production cutover, user-work cancellation, external email or Slack message was performed by this task.
