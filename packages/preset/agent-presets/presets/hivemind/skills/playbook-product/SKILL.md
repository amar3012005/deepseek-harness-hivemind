---
name: playbook-product
description: Load when the user asks to prioritize, scope, or classify PRODUCT work they already listed — features, backlog items, bugs, requirements — into a ranked or scoped artifact. Wins over research even if they say decide. Maps to product.artifact.v1. Requires a product_artifact; prose alone never completes it.
---

# Product playbook

Profile: `product.artifact.v1`. Room kind: `product`. Effect: `prepare_only`. Required artifact: `product_artifact`.

The candidates are already on the table. Ranking a supplied list is this playbook even when the user says "decide". Researching external options they did not list is `playbook-research`.

## Sequence

1. Load `output-contract` if it is not already in context.
2. Take the user's list as the candidate set. Do not add invented features. Company constraints come from `hivemind_meta`, not from guessed roadmap history.
3. Write `product_artifact` in the workspace: ranked or scoped items, the scoring rule used, dependencies, explicit drops, and unknowns. Keep the original item identifiers so the user can map back.
4. If the user also wants market evidence for an item, that evidence is a nested research job with its own `source_ledger`. Do not re-profile the whole turn as research.
5. No visual mock unless they asked for one.

## Completeness

The turn is incomplete until `product_artifact` exists as a workspace file. A chat ranking without the file does not satisfy the profile.
