# Agent Note: History wire bound and authoritative session bootstrap

Status: implemented

## Problem

The deployed generated controller descriptor includes maxTurns, but the compiled client remotes assembly embeds an older request schema that strips it. The client requests five turns while the wire sends only maxMessages. Embedded startup also chooses or creates a session after a timer while its catalog remains pending, competing with an existing session URL.

## Decision

Rebuild the native remotes client assembly after host descriptor generation. Immutable verification invokes the compiled assembly and its actual session/follow codec, requiring maxTurns=5 to survive serialization. Embedded bootstrap selects or creates only after the catalog is ready; authoritative empty catalogs retain normal blank-session creation.

## Alternatives considered

Editing generated schemas or changing session address classification would mask artifact drift. Creating a blank session while the catalog is pending or failed cannot establish that the user has no existing sessions.

## Consequences

The controller contract remains native and unchanged. Overlays must rebuild the assembly after generated contracts change. Focused tests cover pending, route-selected, existing, empty, failed and disposed catalogs. Browser history paging and candidate image gates remain release acceptance checks.
