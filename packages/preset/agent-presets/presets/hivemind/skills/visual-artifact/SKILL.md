---
name: visual-artifact
description: Load only when the user explicitly asked for a visual artifact (logo, mark, mock, screenshot, layout, rendered slide) or a playbook required_artifacts entry is a visual they asked for. Do not load for copy, research, finance, or a vibe about look and feel. Obey output-contract; never invent visual_intent.
---

# Visual artifact

Visual work is opt-in. If this skill was loaded without an explicit visual request, stop using it and continue with the text artifact.

## Sequence

1. Confirm the visual request in the user's words. If the request is only identity, copy, UX critique, or research, unload this path and write the text artifact.
2. Load `output-contract` if it is not already in context. A failed or skipped render must not withhold the textual draft.
3. Ground brand color, mark, or product UI in `hivemind_meta` receipts or user-supplied references. Do not invent a palette and call it the company brand.
4. Write the visual into the session workspace. The path is a local workspace file. A HIVE memory id or title is not a filesystem path and is not proof that a downloadable image exists.
5. Record in the parent playbook artifact: the workspace path, what was requested, what evidence was used, and any gap (missing brand mark, denied render, low-fidelity stand-in).

## Do not

- Open this skill because a verifier or goalkeeper wanted a picture.
- Treat a branding, design, or marketing profile as an automatic render.
- Block copy, contracts, or ledgers on render failure.
- Fetch arbitrary image URLs without native web approval.
