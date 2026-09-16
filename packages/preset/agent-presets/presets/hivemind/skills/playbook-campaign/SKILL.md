---
name: playbook-campaign
description: Load when the user asks to build or plan a multi-step marketing or outreach CAMPAIGN with a channel, cadence, or launch window — a campaign contract, not a single asset. Maps to campaign.contract.v1. Requires a campaign_contract; prose alone never completes it.
---

# Campaign playbook

Profile: `campaign.contract.v1`. Room kind: `campaign`. Effect: `prepare_only`. Required artifact: `campaign_contract`. Review policy: `debate`.

A campaign has more than one step and a window. A single landing page or ad is `playbook-marketing`. Sourced people and one-to-one drafts are `playbook-outreach`.

## Sequence

1. Load `output-contract` if it is not already in context.
2. Ground audience, offer, and constraints in `hivemind_meta`. Named markets or competitors that are not in memory need `research-web` and a source ledger, not invented landscape.
3. Write a durable `campaign_contract` in the workspace covering: goal and success metric, audience, channels, cadence, launch window, assets required, owner per step, and what is explicitly out of scope. Do not execute sends from this playbook.
4. Each required asset stays a named deliverable. Do not inline a full brand book or a full lead list here; point at `playbook-branding`, `playbook-marketing`, or `playbook-outreach` for those jobs.
5. External sends wait for a later connected-app turn with native approval. This profile is `prepare_only`.

## Completeness

The turn is incomplete until `campaign_contract` exists as a workspace file. A narrative plan in chat does not satisfy the profile.
