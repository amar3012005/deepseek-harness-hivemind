---
name: playbook-fundraising
description: Load when the user asks to draft investor-facing fundraising material — pitch narrative, deck story, cap table or SAFE math — for raising capital from investors. Maps to fundraising.artifact.v1. Requires a fundraising_artifact; prose alone never completes it.
---

# Fundraising playbook

Profile: `fundraising.artifact.v1`. Room kind: `fundraising`. Effect: `prepare_only`. Required artifact: `fundraising_artifact`.

Investor-facing narrative and math. Contract or books risk review is `playbook-finance`. Marketing copy for customers is `playbook-marketing`.

## Sequence

1. Load `output-contract` if it is not already in context.
2. Pull traction, product, and team facts from `hivemind_meta`. Do not invent revenue, users, valuation, or dilution. Missing figures stay gaps.
3. Write `fundraising_artifact` in the workspace: narrative arc, claims with receipts, cap-table or SAFE math only from supplied numbers, and a list of statements that must not be used until verified.
4. A slide image or visual deck is opt-in. Load `visual-artifact` only when the user asked for rendered slides. The story document is the required artifact either way.
5. Do not send investor mail from this profile. Outreach to named investors is `playbook-outreach` plus connected-app approval.

## Completeness

The turn is incomplete until `fundraising_artifact` exists as a workspace file. Unverified metrics are labeled; they are not rounded into a clean pitch.
