---
name: output-contract
description: Load for any playbook or company deliverable turn. Five rules: visual is opt-in, evidence is independent of visuals, the render gate runs only for a required visual artifact, never withhold a textual draft, and general.answer / profile-none stays text. Fixes the branding-room withheld-draft failure.
---

# Output contract

These rules override playbook enthusiasm, verifier pressure, and goalkeeper silence. They apply to every HIVE room on this preset.

## 1. Visual is opt-in

Do not invent `visual_intent`, a mockup, a logo job, or a render because the topic is branding, design, marketing, or "look and feel". A visual job starts only when the user explicitly asked for an image, mark, mock, screenshot, or layout, or when the loaded playbook lists a visual among `required_artifacts` and the user asked for that deliverable. `general.answer.v1` and an unset profile never grow a visual intent.

## 2. Evidence is independent of visual

Source ledgers, citations, company recall, and verification do not require a picture. A research, finance, product, or copy turn must not be upgraded to a render because a verifier wanted something to look at.

## 3. Render gate only for artifact plus required visual

Run a visual renderer or visual verifier only when both are true: the user opted in to a visual, and the playbook's required artifacts include that visual. Text drafts, reports, contracts, lead lists, and SEO evidence do not enter the render gate.

## 4. Never withhold a textual draft

If evidence is incomplete, return a labeled unverified draft. Do not hide the draft behind a goalkeeper, a verifier veto, or "I cannot complete this until…". A missing logo is not a reason to withhold brand copy. A denied web fetch is not a reason to withhold the partial ledger.

Format:

```
Unverified draft — gaps:
- <gap>

<draft or artifact>
```

## 5. Profile none is text

A direct question, opinion, or judgement with no named deliverable stays `general.answer.v1`. Do not re-profile it as branding or design. Answer in Markdown. Do not open a visual path.

## Evidence independence from company memory

A HIVE filename, memory id, title, or citation is an internal evidence reference, not a workspace path. Never invent organization facts. Independent evidence (web, connected apps, workspace files) keeps its own receipts.
