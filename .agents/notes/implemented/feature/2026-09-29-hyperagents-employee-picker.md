# Agent Note: Hosted HyperAgents employee picker

Status: implemented

## Problem

The hosted HyperAgents preset could read authenticated employee profiles through a model tool, but users could not choose an employee in the Harness composer or see that identity beside artifact previews. The Da-vinci company room already used deterministic Humation avatars for employees.

## Decision

Keep the existing Standard-derived Harness loop and native right Sidebar. Add a HyperAgents-only composer picker that loads the authorized tenant roster on demand through the existing runner-to-control-plane service token. Selecting an employee invokes a native session command; the Host validates the ID against the same scoped roster, appends `hivemind/employee-selection`, and injects a compact selected-role instruction on later turns. The parent session continues to execute inline.

The right Sidebar gains one Agent tab, and the conversation header swaps focus between that tab and the previously active preview tab. It does not replace artifact viewers. Both surfaces use the same Humation asset, stable employee-ID seed, role colors, and approved avatar URL behavior as the production Da-vinci employee component. Other presets do not render the new controls.

## Verification

Full build, focused runtime and browser-client tests, authenticated roster rejection, and a fresh production browser canary are release gates. The GUI-wide style tests have existing failures on untouched files in this branch; those failures must be recorded separately from new code failures before release.
