# Brain chat opens from local copies and a single list pull

Status: implemented

## Baseline

Read from the Brain client source at `c1a72437ae` (the production image `parity6`); the runner writes no access log, so these are code facts, not timings:

- `SessionManager.refreshList` started a server pull, showed the cached list, then called `session.list` a second time and awaited that one. Every list refresh cost two identical requests.
- The list pull started only in `handleConnected`, after the event stream's ready frame. Every catalog that loaded on construction was reset and read again by the first `connection/reset`.
- `resolveAccountScope` read `/v1/bootstrap`, which the runner host serves as the app-shell HTML, so the account never resolved and the list cache stayed empty.
- A prompt sent while the Host restarted failed with raw transport text instead of being held.
- The composer model selector fetched `/api/hivemind/model-connection/status` on mount, every 5 s and on focus, one request per selector.
- Streamed text reveal relied on animation frames only.
- A Postgres tunnel or restart blip at boot ended the process (one probe, no pool `error` listeners).

## Decision

Port the Runtime fixes that apply to Brain, each in its own commit with its own note or test: Worker JSON bootstrap route; local copy of the session list and the newest history page, with opening an exact route before the list; held sends; Postgres boot retry and pool error containment; list pull at apply with first-generation catalog reuse and a slow carrier kept; one read per page for the roster, commands, feedback, subagent catalogs and account probe; one adaptive text reveal with a timer fallback.

## Not ported

- Server access and membership caches (`StaleWhileRevalidate`): Brain's web-runner has no per-RPC Core check; its only Core calls are the project catalog, profiles and the onboarding screenshot routes.
- Native prompt-cache prefix and history-rewrite batching: the Brain chat preset mounts neither `hivemind-playbooks` nor `hivemind-context`; those plugins belong to the HQ and HyperAgents presets.
- Runtime-only appearance, tour, awakening gate and HQ workspace shares.

## Consequences

Brain's database and runner share a host, so the cross-region latency that motivated parts of the Runtime work does not apply; the gains are fewer requests per load, a warm second visit, and no dead gap before the first list.
