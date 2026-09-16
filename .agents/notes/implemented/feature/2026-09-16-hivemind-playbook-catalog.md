# Agent Note: HIVE-MIND playbook catalog on the isolated skill provider

Status: implemented

English | [中文](2026-09-16-hivemind-playbook-catalog.zh.md)

## Problem

The `hivemind` preset already clones Standard and adds authenticated company plugins, but its skill provider is isolated: `includeDefaultRoots: false` so a greeting does not pay for the user's whole development catalog. Isolation without a replacement root meant the catalog was empty. The only on-disk company skill, `composio-connected-workflows`, sat beside the composition and was invisible to that preset. `hivemind-chat` already pointed `customSkillDirs` at `presets/hivemind/skills/`, so the chat preset and the full company-brain preset disagreed about whether a catalog existed.

Company rooms still need the HyperAgent `execution_profiles` playbooks and the output-contract rules (visual opt-in, never withhold a textual draft) before a Room-as-Session webhook or Agent Teams can do real work. A second taxonomy of room kinds would drift from the profiles HIVEMIND already runs.

## Decision

The curated company catalog lives in `packages/preset/agent-presets/presets/hivemind/skills/<name>/SKILL.md`. Both HIVE presets discover that one directory. `includeDefaultRoots` stays `false`. `watch` stays `false`. The native `skill` tool stays mounted. `hivemind_capabilities` still withholds the catalog until the model asks for a playbook. The Lead persona remains a company brain and does not set `complete: true`.

### Catalog location

Discovery is one-level `<root>/<name>/SKILL.md`. The `hivemind` skill-filesystem row uses `customSkillDirs` with `baseUrl` so the root resolves wherever the shipped preset is installed:

```js
process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))
```

`hivemind-chat` keeps the sibling path `../hivemind/skills/`. There is no second skill tree.

### Playbook mapping

Playbook skills map 1:1 onto existing `EXECUTION_PROFILES` except `general.answer.v1`, which is the default direct-answer profile and has no skill.

| Skill | Profile id | Required artifacts |
|---|---|---|
| `playbook-research` | `research.decision.v1` | `source_ledger`, `decision_artifact` |
| `playbook-campaign` | `campaign.contract.v1` | `campaign_contract` |
| `playbook-outreach` | `outreach.prepare.v1` | sourced leads and verified drafts |
| `playbook-marketing` | `marketing.artifact.v1` | `marketing_artifact` |
| `playbook-seo` | `seo.audit.v1` | `seo_evidence` |
| `playbook-branding` | `branding.artifact.v1` | `branding_artifact` |
| `playbook-fundraising` | `fundraising.artifact.v1` | `fundraising_artifact` |
| `playbook-product` | `product.artifact.v1` | `product_artifact` |
| `playbook-design` | `design.artifact.v1` | `design_artifact` |
| `playbook-finance` | `legal_finance.review.v1` | `review_artifact` |

Each playbook names its profile id, room kind, effect (`prepare_only`), and the workspace files that prose must not replace.

### Shared skills

Cross-cutting catalog entries are `output-contract` (the five rules: visual opt-in, evidence independent of visual, render gate only for a required visual artifact, never withhold a textual draft, profile-none stays text), `visual-artifact` (explicit visual request only), `research-web` (native `web_search` / `web_fetch`, distinct from company memory), and the existing `composio-connected-workflows`. Multi-source company recall stays the runtime skill `hivemind-company-brain`; this catalog does not duplicate it as `hive-recall` / `hive-portrait` / `hive-evidence`.

### Wiring

`packages/preset/agent-presets/presets/hivemind/agent.cordis.yml` adds `customSkillDirs` on the existing `skill-filesystem` row (`providerName: hivemind-filesystem`). No Agent Teams plugin, no webhook product bridge, and no Docker MCP Gateway row is added.

### Out of scope

This change does not create a HyperRoom, a Session webhook, a teammate roster, a Composio slug explosion, or a production runner image. Live `hivemind-harness-runner` and employees-service stay untouched. Company memory stays in HIVE Core.

## Alternatives considered

- **`bundledSkillDir` instead of `customSkillDirs`** — rejected: an isolated provider already drops the environment bundled root, and the shipped `cordis` / `hivemind-chat` presets already use `customSkillDirs` plus `baseUrl`. Rank 300 custom is the matching discovery bucket.
- **A second taxonomy of room kinds or Grok-Bot jobs** — rejected: playbooks must stay 1:1 with `execution_profiles.py` or the Director and the Cordis room will disagree about required artifacts.
- **Splitting marketing into copy vs artifact skills** — rejected: the registry only has `marketing.artifact.v1`.
- **Filesystem skills for recall, portrait, and evidence** — rejected: `hivemind-company-brain` is already registered by `hivemind-runtime`.
- **`complete: true` on the Lead persona** — rejected: that flag suppresses Team and skill assembly.
- **Scanning default project/user skill roots** — rejected: that is the greeting-token cost the isolated provider exists to avoid.
- **Rebuilding the pipeline from Cordis packages** — rejected: production tenancy stays in HIVEMIND; this clone upgrades the reserved `hivemind` preset.

## Consequences

`hivemind_capabilities` now reveals the curated catalog (ten playbooks plus four shared skills, and the runtime company-brain skill) instead of an empty list. Both HIVE presets share one directory, so a playbook edit lands in chat and in the full company-brain preset together. Catalog token cost is paid only after an explicit capability request. Later stages still have to add Room=Session wiring, Agent Teams, and Enigma canaries; those must not invent a parallel skill tree.

## Testing

`packages/preset/agent-presets/tests/shipped-root.spec.ts` asserts isolated provider config, `customSkillDirs` wiring on both HIVE presets, the exact skill directory inventory, playbook-to-profile id presence, and the five output-contract rules. No recorded-session snapshot is added: the catalog is withheld until `hivemind_capabilities`, and this repository has no existing hivemind snapshot owner. Headless keyed E2E still needs the lab-only `DSH_SANDBOX_MODEL_KEY`.
