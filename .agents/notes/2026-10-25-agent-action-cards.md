# One agent action card for approvals and questions

AMAR (25 Oct 2026) asked that every approval or question from an agent, in Brain, Runtime and HyperAgent rooms, look like the HyperAgent room's approval card.

## Decision
- **Card:** a 0.5px neutral hairline border, 18px corners, and the level-2 shadow on the input surface. The warning-tinted border and band are gone, and the card rises 6px when it appears (no motion under Reduce Motion).
- **Strip:** a quiet band with a 6px warning dot and an 11px uppercase label: "Needs your approval", "Question for you", "Plan review" or "Save to HIVE-MIND". The question card's minimize and dismiss controls move into this strip.
- **Structured detail:** an app row with its fields reads in the body face. Only a bare shell command keeps the code face.
- **A lone question** shows no 1 / 1 pager.

## Rejected
- **Action-named approval labels (Send email / Discard), as in HyperAgent rooms:** the label would need the Tool detail slot to inform the approval owner. That is deferred until the approval request carries a presentation label.

## Evidence
- The real `ApprovalPanel`, `QuestionComposer`, `PlanReviewPanel` and `DestinationApprovalPanel` were rendered in a local Vite fixture at 375pt and 820pt in Chromium, and compared against the HyperAgent card.
- `vitest run packages/client/ui-approval packages/client/ui-user-questions` passes.
