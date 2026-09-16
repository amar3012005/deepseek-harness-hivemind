---
name: playbook-branding
description: Load when the user asks to define or critique brand identity itself — voice, tone, personality, visual or verbal identity, archetype — not a single marketing asset or a multi-step campaign. Maps to branding.artifact.v1. Requires a branding_artifact; prose alone never completes it.
---

# Branding playbook

Profile: `branding.artifact.v1`. Room kind: `branding`. Effect: `prepare_only`. Required artifact: `branding_artifact`.

A branding room defines or critiques identity. It is not a marketing copy job, a campaign plan, or a logo render unless the user also asked for those.

## Sequence

1. Load `output-contract` if it is not already in context. Visual work is opt-in; a branding draft is still due when no image was requested.
2. Ground identity in authenticated company evidence. Call `hivemind_meta` (`context` or one focused `recall`) before inventing voice, palette, or archetype. If the receipt is empty, say so and continue with a labeled unverified draft.
3. Produce a durable `branding_artifact` in the workspace. Include voice and tone, personality traits, verbal identity (tagline territory, words to use and avoid), and any visual identity rules the evidence supports. Do not substitute a conversational essay for that artifact.
4. Load `visual-artifact` only when the user explicitly asked for a mark, logo, color board, or other image. Identity copy does not enter the render gate.
5. Connected apps, outreach lists, and campaign calendars belong to other playbooks. Do not silently switch profile.

## Completeness

The turn is incomplete until `branding_artifact` exists as a workspace file. Partial evidence yields a labeled unverified draft plus the artifact, never a withheld answer.
