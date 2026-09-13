# Agent Note: HIVE budgets reasoning by durable workflow stage

Status: implemented

English | [中文](2026-09-13-hivemind-stage-reasoning-policy.zh.md)

## Problem

Forcing one reasoning effort across every HIVE request either wastes tokens on direct and bounded work or weakens complex playbook execution. Prompt instructions that ask for short thinking do not reliably control provider reasoning-token spend. A text classifier would duplicate the model's intent decision and require app-specific maintenance.

## Decision

The HIVE runtime uses the native `agent/request` waterfall without changing the Cordis loop. It derives only a durable workflow stage from current-turn tool events:

- A first decision and exact contract-mapping continuation request `low`.
- Synthesis after a completed bounded HIVE lookup, connected execution, or connection-status receipt requests `off`.
- Continuation after the model deliberately loads a detailed skill requests `high`.

Before admission, the registered adapter validates the proposed effort for the exact selected model. A model that does not support the effort, including a mandatory-reasoning model, keeps its native default. An explicit effort selected through native model/session controls remains authoritative.

The policy contains no prompt regex, user identifier, provider name, toolkit name, or app-specific rule. Full request headers and workflow events remain append-only and replayable.

## Verification

Runtime tests cover initial, bounded, connected-search, connected-execute, and skill-loaded stages. They also prove explicit effort is preserved and unsupported effort falls back. Focused HIVE context, runtime, connected-app, preset, and bundle tests remain green, and the runtime package passes targeted TypeScript checking.

## Consequences

The model still makes the intent, capability, skill, and tool decisions. HIVE controls only the provider budget after that decision becomes durable. Future skills inherit the same behavior because the policy recognizes the native skill tool rather than any skill name.
