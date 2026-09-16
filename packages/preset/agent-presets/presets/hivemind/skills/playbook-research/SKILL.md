---
name: playbook-research
description: Load when the user asks to research external facts (competitors, market, a named entity) and recommend a choice BETWEEN options found via that research. Not for ranking a list the user already supplied. Maps to research.decision.v1. Requires source_ledger and decision_artifact; prose alone never completes it.
---

# Research playbook

Profile: `research.decision.v1`. Room kind: `research`. Effect: `prepare_only`. Required artifacts: `source_ledger`, `decision_artifact`. Review policy: `reviewer`.

External facts, then a choice among options those facts produced. A user-supplied backlog to rank is `playbook-product`. Company memory alone is `hivemind_meta`, not this playbook.

## Sequence

1. Load `output-contract` if it is not already in context. Load `research-web` before any `web_search` or `web_fetch`.
2. Separate internal evidence (`hivemind_meta`) from external evidence (web). Never present a web page as company memory, and never invent a competitor, metric, or quote.
3. Write `source_ledger` in the workspace as the first durable artifact. Each row is one source with URL or memory id, retrieved claim, and a confidence note. Unsupported claims do not enter the decision.
4. Write `decision_artifact` with the options actually found, the recommended choice, the rejected alternatives, and the gaps. Do not recommend an option that has no ledger row.
5. Do not render charts or slides unless the user asked for a visual; then load `visual-artifact`. The required artifacts remain the ledger and the decision.

## Completeness

The turn is incomplete until both artifacts exist. If search fails or is denied, return a labeled unverified draft and an empty-or-partial ledger — never a withheld recommendation.
