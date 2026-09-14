# Agent Note: Cached HIVE shell remount and floating view switcher

Status: implemented

## Problem

The Da-vinci host added a random query value whenever it imported the native
Harness shell. Every Overview remount therefore downloaded and parsed the same
browser application again. The HIVE CSS also hid the complete native Session
header, which removed the Chat and Trajectory view switcher together with the
duplicate title chrome.

## Decision

The Web entry exports its ordinary `mount()` lifecycle and the promise for its
first document mount. An embedded SPA can now import one module URL keyed by
the authenticated boot graph revision, await the first mount, and call the
same exported mount on later route entries. A release revision change still
loads new code; route remounts reuse the already downloaded and parsed module.

HIVE mode continues to hide the native title row, but preserves the view tabs
as a small absolute overlay at the conversation root's lower-left. Native mode
keeps its existing header and tab geometry unchanged.

## Alternatives considered

A longer HTTP cache for random URLs cannot produce module-instance reuse.
Removing the random value without an explicit remount would leave later SPA
entries blank because ESM evaluation runs once. The lower-left control is
HIVE-specific CSS over the native tab contract; it does not introduce another
router or duplicate view state.

## Consequences

Returning to Overview within one browser document no longer transfers or
parses another randomly-addressed shell. The authenticated boot graph remains
fresh on every entry, and changing its release revision invalidates the module
cache. Chat and Trajectory occupy a small lower-left overlay in HIVE mode; the
composer and transcript keep their existing layout and native Harness keeps
its original header.

## Verification

Focused browser-entry, conversation, and host tests pin revision-stable module
URLs, explicit remount availability, lower-left HIVE tabs, and unchanged native
Chat/Trajectory behavior. The assembled HIVE profile remains the release
composition used for image verification.
