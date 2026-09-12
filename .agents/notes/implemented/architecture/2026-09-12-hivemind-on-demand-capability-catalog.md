# Agent Note: HIVE capability catalog is requested on demand

Status: implemented

English | [中文](2026-09-12-hivemind-on-demand-capability-catalog.zh.md)

## Problem

The native skill plugin offered the compact HIVE catalog on every first model step. Even a greeting or a question already answerable from recent conversation paid for catalog injection and encouraged unnecessary planning. A server-side keyword classifier reduced some calls but made capability availability depend on guessed intent and would require maintenance for every future skill.

## Decision

The initial HIVE model step contains the system contract, bounded completed user/final-answer exchanges, and any unfinished current workflow state. Direct registered HIVE and connected-app tools remain available. The HIVE context overlay withholds only native messages whose source is `skill-catalog`.

When detailed playbook guidance is genuinely needed, the model calls the no-argument `hivemind_capabilities` tool. Its durable tool-call event is the capability request. On the following model step, the unchanged native skill plugin's current catalog is allowed through, and the model may load one relevant skill. This is generic across future skill registrations: there are no user-specific values, app-name branches, prompt regexes, replacement planners, or changes to the native agent loop.

The HIVE Web profile also sets the default OpenRouter model reasoning effort to Harness `off`, mapped to provider value `none`. Other configured efforts remain available through native model configuration.

## Verification

Focused context tests prove that greetings and ambiguous first steps do not receive a catalog, while a same-turn durable `hivemind_capabilities` call reveals it. Runtime tests prove the tool is registered and executable without loading profile data. Preset tests assert the first-step and concise-clarification contract. Bundle tests assert the OpenRouter reasoning mapping and default effort.

## Alternatives considered

**Preload the compact catalog on every turn.** Rejected because it adds prompt cost and planning pressure to direct answers.

**Classify request text before the model runs.** Rejected because keyword routing guesses intent, creates app-specific maintenance, and can hide a capability the model needs.

**Patch the native skill plugin or agent loop.** Rejected because HIVE is an overlay and must inherit native Harness behavior unchanged.

**Hide reasoning with OpenRouter `exclude`.** Rejected because it suppresses returned reasoning text but does not stop the model from spending reasoning tokens.

## Consequences

A task that needs a detailed skill uses one additional bounded capability-request step. Direct answers, concise clarifications, single HIVE lookups, and bounded connected-app work avoid the catalog entirely. Full session events remain durable for replay, while later ordinary requests receive only the configured completed conversation projection.
