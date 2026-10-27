# Instant Runtime open from a local copy

Status: implemented

## Decision

The browser keeps one account-scoped IndexedDB copy (`hm-swr-cache`) for the session list and for each root Session's last durable history page. One bootstrap probe per page load identifies the account for every read and write; an unavailable probe is retried by the next caller, and a sign-out or account change clears the previous account's keys.

`session.list` starts before the local list is read, so the server pull no longer waits for the bootstrap probe and IndexedDB. A cached list seeds each row's projection store (title, preset, status values) as the server list does.

A root Session draws its cached tail while its server tail page is pending. The cached rows are display-only: they set no paging cursor and acknowledge no submissions. The server `replace` page always supersedes them, and a cached tail that arrives after the server page is ignored. One second after the server window settles, the durable tail is written back: at most 400 entries and 750,000 serialized characters, cut at a `turn/start`, for at most 60 Sessions per account (least recently written are removed).

A HIVE base route (`/hivemind/app/overview`, `/hivemind/app/employee/harness`) reopens the room last opened in that mode on this browser through `resolveExisting(id, { open: true })` without waiting for `session.list`. The stored id carries no authority; a denied or missing room falls back to the ready-list selection.

`ui-hivemind-connect` shares one in-flight `schedule.catalog` read across its readers, rereads only on `connection/reset`, `schedule/changed` and window focus, and no longer reads on every connection state change.

## Rejected

Showing the cached list before the bootstrap probe confirms the account was rejected: on a shared browser a different signed-in account would briefly see the previous account's room titles.

## Not measured

The change was verified with unit tests. No authenticated production or local browser timing was recorded for it; the release owner measures warm open and room switching after deployment.
