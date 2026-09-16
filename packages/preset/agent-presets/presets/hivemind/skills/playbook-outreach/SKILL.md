---
name: playbook-outreach
description: Load when the user asks to find or contact specific real people or companies — sourced leads, prospects, named recipients — and wants outbound message or call drafts, not campaign strategy. Maps to outreach.prepare.v1. Requires source_backed_lead plus message or call drafts; prose alone never completes it.
---

# Outreach playbook

Profile: `outreach.prepare.v1`. Room kind: `outreach`. Effect: `prepare_only`. Required artifacts: `source_backed_lead`, `message_draft_for_verified_recipient`, `call_brief_for_verified_phone`. Review policy: `reviewer`.

People and companies, sourced. A channel calendar is `playbook-campaign`. A generic pitch with no recipients is `playbook-marketing`.

## Sequence

1. Load `output-contract` if it is not already in context.
2. Discover candidates from `hivemind_meta` recall/entities first, then `research-web` or connected CRM/mailbox search. Never invent a person, company, email, or phone number.
3. Persist `source_backed_lead` rows in the workspace. Each lead must carry a source receipt (HIVE memory id, web URL, or connected-app receipt). Drop any row that cannot cite one.
4. Draft `message_draft_for_verified_recipient` only for leads with a verified destination. Draft `call_brief_for_verified_phone` only for leads with a verified phone. Missing destinations stay listed as gaps on the lead artifact; do not fabricate them.
5. Do not send. Sends, invites, and sequences use `hivemind_connected_task` in a later turn with native approval. This profile is `prepare_only`.

## Completeness

The turn is incomplete until the three artifacts exist. Empty lead lists with an honest source ledger are valid; invented contacts are not.
