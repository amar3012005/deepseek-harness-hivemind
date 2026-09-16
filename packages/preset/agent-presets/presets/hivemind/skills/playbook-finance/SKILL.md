---
name: playbook-finance
description: Load when the user asks to review legal or financial risk in a contract, deal term, or financial position and flag concerns. Maps to legal_finance.review.v1. Requires a review_artifact; prose alone never completes it. Not legal advice and not a live books close.
---

# Finance and legal review playbook

Profile: `legal_finance.review.v1`. Room kind: `legal_finance`. Effect: `prepare_only`. Required artifact: `review_artifact`. Review policy: `reviewer`.

Risk flags on a supplied instrument or position. Investor narrative and pitch math are `playbook-fundraising`. This playbook does not file, sign, wire, or change a live ledger.

## Sequence

1. Load `output-contract` if it is not already in context.
2. Work only from user-supplied text, workspace files, or `hivemind_meta` receipts. Do not invent clauses, numbers, jurisdictions, or cap-table state.
3. Write `review_artifact` in the workspace: issues found, severity, the exact source span for each flag, open questions, and what was not reviewed. Label every conclusion as an internal review, not legal or financial advice.
4. If a figure depends on a connected book, bank, or contract store, discover it through `hivemind_connected_task`. Missing connections are gaps, not guesses.
5. Do not execute payments, signatures, or filings from this profile.

## Completeness

The turn is incomplete until `review_artifact` exists as a workspace file. An incomplete document still yields a labeled unverified draft covering only the spans actually read.
