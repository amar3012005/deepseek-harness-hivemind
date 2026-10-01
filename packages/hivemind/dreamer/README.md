# Autonomous company Dreamer

Native Cordis plugin: Cloudflare alarms and Queue admit an occurrence; PostgreSQL
persists its identity and lease before native `startContinuable` creates the Dreamer.
The agent chooses its own topics and paths through company-visible evidence.
Cold recovery uses the same child session, checkpoint and idempotency keys.

## Consent and destination

Dreaming starts OFF. An organization admin turns it on in native General settings.
That opt-in authorizes direct derived-memory writes into the reserved **Flashbacks**
project (`org_visible`); all active company members can read it. There is no
per-dream approval. The Dreamer cannot choose another destination or invoke ordinary
company-write tools. Turning OFF cancels work and removes the recurring trigger;
previous Flashbacks remain. Private/team/personal sources are excluded from shared
outputs. Flashbacks are company memory, separate from HyperAgent operating memory.

Every output includes source memory IDs, reasoning type, confidence, workflow and
run identity. Sources are rechecked immediately before save; the canonical receipt
and actual project destination are verified before completion. Derived saves skip
smart routing to preserve their inference semantics. No output is also a valid run.

## Deployment

Apply `20260930220000_dsh_dreamer` before loading the plugin. Configure runner secrets:
`HIVEMIND_DREAM_DISPATCH_URL`, `HIVEMIND_DREAM_ADMIN_TOKEN`,
`HIVEMIND_DREAM_DISPATCH_TOKEN`, `HIVEMIND_DREAM_CALLBACK_TOKEN`.
Configure the corresponding dispatcher secrets and native trigger/status URLs.
Tokens must be at least 24 characters. Keep tenant settings OFF during verification.
Optional `HIVEMIND_DREAM_MODEL` and `HIVEMIND_DREAM_MODEL_PROVIDER` select the child
model. Otherwise native provider configuration applies.

Endpoints: authenticated GET/PUT `/hivemind/dreamer/settings`; service-authenticated
POST `/hivemind/dreamer/trigger`; tenant-scoped GET `/hivemind/dreamer/runs/{id}`.
The occurrence key is `{org}:dreaming:{scheduledMillis}` and must match its timestamp.
Settings revision rejects stale deliveries. Run leases fence retries; candidate
keys suppress repeated writes; callback retries recover missing terminal receipts.

## Source map

- `src/index.ts`: plugin composition, routes, native delegation, tools, dispatch sync.
- `src/store.ts`: tenant transactions, settings, leases, checkpoints and output ledger.
- `src/contract.ts`: strict payload/candidate schemas and stable identities.
- Native General setting: `ui-hivemind-connect/src/client/DreamingSettings.tsx`.
- Tests: contracts, non-superuser PostgreSQL isolation and real native delegation
  with a deterministic model/provider fixture.

Company memory reads currently use the configured PostgreSQL store. Remote residency
stores need their corresponding authorized read adapter before enabling Dreaming.

References: `docs/subsystems/subagent.md`, `docs/subsystems/schedule.md`.

## Automation tasks visibility

Automation tasks includes a read-only Nightly Dreaming card. Its next run comes
from the existing Cloudflare trigger; its history comes from the tenant-scoped
PostgreSQL ledger. The On/Off control remains on main HIVEMIND Settings.
Each tenant retains one native continuable Dreamer conversation. The earliest retained parent/child pair is reused, including after upgrade; occurrence rows retain separate checkpoints, output receipts and callbacks. The Nightly Dreaming title opens the native child address on the dedicated Dreaming route. Both controller and child remain excluded from Recent through native subagent classification. Cold activation mounts the Chat preset and explicitly resolves a model/provider through agentDefaultModel; a failed model turn terminates its occurrence instead of retrying indefinitely. Native compaction controls growing conversation context.
