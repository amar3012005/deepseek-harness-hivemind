# Agent Note: Artifact delivery without a session filesystem

Status: implemented

English | [中文](2026-09-29-virtual-workspace-artifact-delivery.zh.md)

## Problem

HyperAgents uses a virtual workspace. PDF generation assumed its session directory was writable, so rendering failed before producing a receipt. The right sidebar also tried to open artifacts through the workspace-file service, which the HIVE web profile disables.

## Decision

The HyperAgents preset renders generated files into durable attachments without writing into the session workspace. PDF and generation events retain file references and image previews. The Session Remote serves a generated file only after finding its exact attachment reference in the addressed Session log. The operating card and right sidebar read through that Remote; the latter opens PDFs from browser object URLs.

Other presets retain workspace-file output. The attachment read has a 64 MiB size limit and checks streamed byte count against the committed reference.

## Alternatives considered

**Make `/opt/deepseek-harness` writable.** Rejected because a container filesystem is not durable session storage and would not repair the disabled workspace-file read path.

**Enable workspace files for HyperAgents.** Rejected because that broadens filesystem access for a profile designed around a virtual workspace.

## Consequences

PDF rendering and download no longer depend on a session directory. The model receives a filename and durable receipt, not an editable workspace path. Large artifacts above the bounded Remote limit need a future streamed attachment transport.
