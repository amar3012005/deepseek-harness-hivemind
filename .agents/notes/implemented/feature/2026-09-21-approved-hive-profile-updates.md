# Agent Note: Approved HIVE profile updates

Status: implemented

English | [中文](2026-09-21-approved-hive-profile-updates.zh.md)

## Problem

The chat can read maintained profile facts but cannot apply a requested correction. Saving a preferred-name memory does not update the profile used for authenticated context.

## Decision

The memory plugin exposes an optional provider-backed profile setter. Native user questions display exact descriptive fields before approval. The runtime writes caller-scoped facts through the existing profile store and invalidates its profile snapshot. The preset distinguishes profile changes from durable memory saves. Save instructions require grounded entity tags for explicitly named entities.

Profile receipts use ignorable events, so readers without the plugin can still open history. Cancellation performs no write; a completed call replays its receipt. Jev's write capability exposes the approved profile tool alongside memory save without adding a planner.

## Alternatives considered

**Preference memory only.** This leaves the maintained profile stale and does not satisfy an explicit profile correction.

**Account or permission mutation.** The request needs descriptive profile facts, not changes to authentication, ownership or access roles. The server accepts only the six maintained-profile fields.

## Consequences

Profile changes use one store request after approval without an extra model step. Tests cover exact approval, cancellation, completed-call replay, invalid fields, transport and provider failure. The tool does not promise atomic multi-field writes; an incomplete provider response requires reading the profile before retrying.
