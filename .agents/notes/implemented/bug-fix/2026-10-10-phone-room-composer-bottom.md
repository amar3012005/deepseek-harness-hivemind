# Agent Note: Empty native phone room composer

Status: implemented

## Problem

The phone hero grid targets Brain alone, so an empty specialist room retains the desktop centered composer despite using the same native room layout.

## Decision

The seven phone hero rules target `data-native-chat`. Resolved Brain and specialist rooms share the existing bottom input grid at widths up to 600px. Desktop rules and session authorization remain unchanged.

## Alternatives considered

Moving the input with fixed positioning would create a second layout model and risk covering suggestions or the keyboard. Forcing editability while history is unresolved would discard the native live-context gate.

## Consequences

A real Chromium layout test measures the input against the usable viewport at two phone sizes, a shortened keyboard viewport, and desktop width. It checks input placement and typing in a resolved layout fixture; signed-in session restoration, switching, keyboard integration, and draft persistence require separate browser acceptance.
