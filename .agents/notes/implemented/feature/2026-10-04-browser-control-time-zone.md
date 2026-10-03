# Agent Note: Browser control time zone

Status: implemented

## Problem

Fresh Runtime rooms have no user-rpc timezone history. The human Wake up control schedules an automatic startup turn before chat submission, so native time-context fell back to the runner zone. Later ordinary chat turns correctly supplied browser provenance.

## Decision

The existing human control RPC carries an optional browser timezone. The host validates and canonicalizes it through the native time-context helper, then injects a quiet source-attributed confirmation before saving the startup timer. Native request-zone derivation recognizes this confirmation alongside user-rpc provenance; existing scheduled-zone inheritance uses either source. No human chat task or new clock loop is fabricated.

## Consequences

Reset still clears old context. The current browser supplies fresh provenance, while callers without it retain existing fallback behavior. Timezone does not confer authority or determine test duration. Focused regressions cover a fresh control turn before any user RPC, a later inherited scheduled turn, invalid zones and browser request propagation. Native session events preserve the confirmation; the RPC's optional field requires normal Typert output regeneration on release.
