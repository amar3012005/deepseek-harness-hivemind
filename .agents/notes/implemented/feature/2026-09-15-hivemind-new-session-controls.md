# Agent Note: HIVE new-session controls

Status: implemented

## Problem

The native HIVE composer needs its scope and application discovery controls only while a session is blank. The prior hero connector registration resolved the current session instead of the hero session, so its suggestions could disappear despite the hero being rendered.

## Decision

The HIVE plugin renders a folder-marked, server-authorized scope selector in the native hero row and renders connector suggestions through the hero session supplied by the conversation slot. The suggestions vanish with the hero when a session becomes active. Connector search preserves an authenticated HTTPS logo into the shared trigger menu, which renders it instead of a generic reference glyph.

## Alternatives considered

**Keep the composer-level connector dock.** It would expose connected-app suggestions during active conversations, which is outside the new-session-only interaction.

**Fetch a connector catalog before the user types `@`.** This would make application discovery eager and expose unavailable provider metadata; the existing authenticated, lazy search remains the authority for search results.

## Consequences

The native blank-session composition now owns presentation only; project authorization remains the runner's project endpoint and provider/tool selection remains unchanged. The shared trigger candidate carries an optional display-only logo field, so non-connector sources retain their existing icon behavior.

## Testing

Focused component tests cover the folder control, hero connector logos, HTTPS connector-search logos, and menu logo rendering. The assembled GUI and browser-replay checks remain required before release.
