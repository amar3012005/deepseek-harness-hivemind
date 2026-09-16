---
name: playbook-design
description: Load when the user asks to critique or design UX/UI — usability of a flow, screen, or interaction pattern. Maps to design.artifact.v1. Requires a design_artifact; prose alone never completes it. A logo or brand mark is branding plus visual-artifact, not this playbook.
---

# Design playbook

Profile: `design.artifact.v1`. Room kind: `design`. Effect: `prepare_only`. Required artifact: `design_artifact`.

Flows, screens, interaction patterns. Brand identity is `playbook-branding`. A requested picture of a screen is visual-opt-in on top of this artifact, not a replacement for it.

## Sequence

1. Load `output-contract` if it is not already in context.
2. Ground the critique in the supplied flow, screenshot, or product facts from `hivemind_meta`. Do not invent current UI.
3. Write `design_artifact` in the workspace: problem, affected steps, recommended interaction, and acceptance checks. Prefer structured annotations over a vibe paragraph.
4. Load `visual-artifact` only when the user asked for a mock, wireframe image, or exported frame. A written UX critique does not enter the render gate.
5. Implementation work (code, components) is a coding task on the native tools, not a substitute for `design_artifact`.

## Completeness

The turn is incomplete until `design_artifact` exists as a workspace file. Missing screenshots produce a labeled unverified draft, not a withheld critique.
