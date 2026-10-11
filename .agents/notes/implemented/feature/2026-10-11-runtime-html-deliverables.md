# Agent Note: Runtime HTML deliverables

Status: implemented

English | [中文](2026-10-11-runtime-html-deliverables.zh.md)

## Problem

HTML was the suggested default, but permanent persona and production guidance also allowed PDF for an inferred delivery need. Generic generator descriptions and employee assignments omitted the default, so scheduled or delegated work could produce an unsolicited PDF.

## Decision

The permanent Runtime and HyperAgent personas, native production/design skills, generator descriptions and employee assignment prompt use saved HTML for unspecified substantial written deliverables. PDF and other document formats require an explicit human format request. Existing recorded explicit final-format requirements remain authoritative; Runtime carries the format and human source in native Team task descriptions and acceptance criteria. Generation continues through the existing `hivemind_generate` web provider.

Runtime inspects the pages and sections needed for a completeness claim and shares task-relevant inspected content or an accepted readable transfer. Source citations alone do not authorize colleague access. After actual inspection, acceptance and completed company work, Runtime sends one scoped administrator completion notification through the existing sender, reusing its saved message key and content. Employees report to Runtime.

This narrows the deliverable policy alongside [Runtime stage guidance](2026-10-11-runtime-stage-guidance.md). It does not replace native task ownership, artifact review, persistence or authorization.

## Alternatives considered

Retaining the inferred PDF exception would leave the same unsolicited-format behavior. Rewriting formats in a host classifier or adding another artifact subsystem would override recorded human requirements or duplicate the native provider. Instructions at the existing persona, task and generation seams preserve those requirements and reuse native delivery.

## Consequences

Input modality does not select output format. Existing PDF sources remain inspectable. Tool schemas, generator availability and format-specific providers remain unchanged. These are model instructions, not a new execution loop or a parser that infers human permission from words. Runtime still must verify actual output and notification receipts.

## Testing

Native Persona and AgentLoop tests inspect model requests after human, call-context, Schedule and employee-message inputs for both shipped presets. Delegation tests preserve HTML, PDF and PPTX requirements through immediate and scheduled prompts. Existing generation tests exercise the saved HTML provider and explicit format routes. Live model behavior is a separate release verification.
