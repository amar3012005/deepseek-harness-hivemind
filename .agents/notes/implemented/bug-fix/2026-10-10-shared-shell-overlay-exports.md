# Agent Note: Shared shell exports in immutable overlays

Status: implemented

## Problem

The b6af0f7b64 runner overlay compiles a notification renderer that consumes `IconBellOutline16` and a primitives library that exports it, but retains a web shell whose shared primitives namespace omits that export. Native conversation rendering therefore receives an undefined component. The overlay builder rebuilds client packages without rebuilding `apps/web`.

## Decision

The overlay release helper compiles primitives before rebuilding the shared web shell. Immutable image verification parses the compiled library exports and the actual shell seed's namespace initializer with the TypeScript AST, then rejects missing namespace properties. Plugins keep using the shared primitives instance.

## Alternatives considered

Inlining a second bell icon into the notification renderer would hide this instance of artifact drift while leaving future shared exports vulnerable. Checking source declarations or the primitives library alone cannot verify the browser shell's actual namespace.

## Consequences

Overlays that change shared primitives also rebuild the web shell and copy the verification scripts. This adds a frontend build to those images and prevents publishing a plugin with unavailable shared components. The check targets the namespace property names preserved by the current Vite build; a shell namespace representation change requires updating the verifier. History transport failures remain independently observable.
