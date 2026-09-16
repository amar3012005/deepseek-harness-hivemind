---
name: playbook-marketing
description: Load when the user asks to draft marketing or positioning copy as a single deliverable — messaging hierarchy, value prop, ad copy, landing page copy — not a multi-step campaign and not brand identity itself. Maps to marketing.artifact.v1. Requires a marketing_artifact; prose alone never completes it.
---

# Marketing playbook

Profile: `marketing.artifact.v1`. Room kind: `marketing`. Effect: `prepare_only`. Required artifact: `marketing_artifact`.

One asset or messaging system. A channel-plus-cadence launch is `playbook-campaign`. Voice, archetype, or brand identity is `playbook-branding`.

## Sequence

1. Load `output-contract` if it is not already in context.
2. Pull company positioning from `hivemind_meta` before writing claims. Do not invent product facts, customers, or metrics. Web claims need `research-web` and a citation.
3. Write a durable `marketing_artifact` in the workspace: the requested copy plus audience, offer, proof points that have receipts, and a forbidden-claims list for anything unverified.
4. Do not render a visual mock of the page or ad unless the user asked for one; then load `visual-artifact`. Copy is the required artifact either way.
5. Connected posts, sends, or publishes use `hivemind_connected_task` (and `composio-connected-workflows` only for multi-app work). This playbook prepares the artifact; it does not skip native approval.

## Completeness

The turn is incomplete until `marketing_artifact` exists as a workspace file. Never replace it with a status report.
