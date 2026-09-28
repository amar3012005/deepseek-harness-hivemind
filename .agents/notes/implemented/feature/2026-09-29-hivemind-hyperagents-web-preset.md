# Agent Note: Authenticated HIVE web runner offers a company-work preset

Status: implemented

English | [中文](2026-09-29-hivemind-hyperagents-web-preset.zh.md)

## Problem

The HIVE web runner admitted only `hivemind-chat`. The existing shipped `hyperagents` preset includes host coding and local workspace tools, so allowing it directly in the embedded tenant-scoped runner would cross the hosted-work boundary.

## Decision

The runner allows `hivemind-chat` and `hivemind-hyperagents`, keeping chat the default. The new preset includes the chat Cordis composition, including isolated HIVE identity, scoped service authority, memory, skills, and governed connected apps. It replaces only the persona and adds native todo tracking. The parent session performs company work inline; an employee profile is an authenticated perspective, not a child agent by default. The native preset picker lists both modes without a frontend fork. Existing sessions retain their selected preset.

## Alternatives considered

**Allow the existing `hyperagents` preset.** Rejected because that full coding composition exposes shell, filesystem, and local workspace capabilities in a hosted company session.

**Fork the agent loop or frontend.** Rejected because the native preset registry and picker already provide per-session composition and mode selection.

## Consequences

Both modes share authenticated tool and approval contracts. HyperAgents changes operating guidance and exposes native todos, but this first stage does not add a durable WorkRun or independent employee execution. Image-level profile checks and an authenticated session canary must prove both modes after each runner release.
