# Brain runner keeps the signed native consent binding

Status: implemented

## Decision

Control Plane `5b7f078014` keeps native mobile admission to `/v1/harness-chat` closed (`MOBILE_RUNNER_NOT_READY`) until the paired runner preserves signed consent bindings. The iOS app reaches `next.singulancelabs.com/api/*`, which the Da-vinci Worker forwards to this Brain runner, so the binding belongs here.

`hivemind-web-runner` now accepts the optional `native_session_hash` ticket claim, keeps it in the signed Connection cookie principal and in the Runner service token, and revalidates a native principal through Control's existing `/internal/v1/harness-chat/core/principal` read before minting the cookie, on boot and on every tenant RPC. Control's `nativeRunnerPrincipalAllowed` checks the hash-indexed live native session, exact user and organization, and current `mobile.ai_consent`. The read is uncached; refusal, timeout and 5xx deny. Principals without the claim (web) are unchanged and make no extra request.

## Evidence

The same seam is in Runtime-Runner `4b8e5be37a` and `72db16c0fd`. `tests/native-consent.spec.ts` covers cookie retention, signed service-token claims, per-RPC revalidation without caching, refusal at exchange and boot, and unchanged web principals; removing the guard check fails two cases.

## Limits

Service tokens minted by other packages (connected apps, research, app builder) do not carry the claim; they run only inside an RPC this guard admitted. Work already admitted is not recalled when consent is withdrawn.
