# One agent action card for approvals and questions

AMAR (25 Oct 2026) asked that every approval or question from an agent, in Brain, Runtime and HyperAgent rooms, look like the HyperAgent room's approval card.

## Decision
- **Card:** a 0.5px neutral hairline border, 18px corners, and the level-2 shadow on the input surface. The warning-tinted border and band are gone, and the card rises 6px when it appears (no motion under Reduce Motion).
- **Strip:** a quiet band with a 6px warning dot and an 11px uppercase label: "Needs your approval", "Question for you", "Plan review" or "Save to HIVE-MIND". The question card's minimize and dismiss controls move into this strip.
- **Actions:** pills with the primary action first, at the leading edge. The secondary action is an outline pill, and a quiet text action (Chat about it) comes last. Pills are 36px tall, or 40px on phones, and press to 96% scale.
- **Structured detail:** an app row with its fields reads in the body face. Only a bare shell command keeps the code face.
- **A lone question** shows no 1 / 1 pager.
- **Connected-app detail (new in Brain):** HQ now renders the app logo and fields for a connected-app approval, as in Runtime.
- **Action-named decisions:** `ui-approval` declares the `conversation.approval.actionLabel` slot, with owner props `callId`, `decision` and `fallback`. It registers its own copy as the default. HQ shadows that default at priority -10 and reads the correlated call: a Gmail send or reply reads Send email / Discard, and a Gmail draft reads Save draft / Discard. Every other call keeps Allow once / Reject.

## Evidence
- The real `ApprovalPanel`, `QuestionComposer`, `PlanReviewPanel` and `DestinationApprovalPanel` were rendered in a local Vite fixture at 375pt and 820pt in Chromium, and compared against the HyperAgent card.
- `vitest run packages/client/ui-approval packages/client/ui-user-questions` and HQ `approval-app-detail` pass.
