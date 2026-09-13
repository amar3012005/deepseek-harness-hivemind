# Agent Note: HIVE entity lookup is a progressive memory operation

Status: implemented

English | [中文](2026-09-13-hivemind-entity-meta-lookup.zh.md)

## Problem

A partial person or organization name can make memory recall noisy, while forcing entity discovery before every recall adds latency and an unnecessary model step.

## Decision

The existing `hivemind_meta` tool exposes an `entities` operation backed by Core `/api/entity-search`. The authenticated runtime derives tenant authority and accepts only a lexical query, optional entity types, an authorized scope narrowing, and a bounded limit.

For a partial or ambiguous named subject, the model performs one entity lookup and passes the selected result's `canonical_name` to `recall.entities`. Exact subjects and recalls without a named subject bypass entity lookup. This remains progressive tool use inside the native Harness loop.

## Alternatives considered

**Run entity discovery before every recall.** Rejected because it adds cost when the subject is already exact or no subject exists.

**Add a deterministic intent router to the agent loop.** Rejected because HIVE capabilities remain model-selected native tools.

**Expose tenant or entity-database identifiers to the model.** Rejected because authenticated Core owns authorization and inventory scope.

## Consequences

Ambiguous name recall gains an evidence-backed canonicalization step without app-specific or user-specific cases. Invalid scopes and limits fail before a Core request. The entity receipt remains available to the current turn, while ordinary history projection keeps prior tool payloads out of later model requests.
