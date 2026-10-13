---
name: hivemind-memory-governance
description: Save, correct, or retrieve durable HIVE company and user evidence.
---

Use this skill only when the user asks to save, correct, retrieve, or reconcile durable HIVE evidence.

Read evidence with one focused `hivemind_meta` lookup. Save only a stable preference, decision, relationship, correction, or verified outcome. Do not save speculation, transient chat, secrets, authentication material, or sensitive personal data without direct instruction. For a correction, retrieve the existing record first and update only that record.

Prepare one complete record before invoking `hivemind_meta` with `operation: "save"`: use a specific title, concise factual content with dates or periods stated explicitly when known, and the correct `source_type` (`decision` for a decision, `documentation` for a source record, otherwise `conversation` or `text`). The native service derives the stored memory type from that source type; never invent an unsupported `memory_type` field. Put every concrete person, organization, product, project, document, system, tool, place, date, period, and distinct subject in `save.entities`; use `save.tags` only for non-entity classifications. Choose the concrete destination scope and project when applicable. For an update, extend, or derived record, include the exact recalled UUID as `related_to` and the matching `relationship`; otherwise omit both.

The save tool opens the native destination-and-approval card. Ask for that approval as soon as a user states a durable atomic fact or a verified new outcome qualifies; do not silently write. Read-only lookups may run in parallel; writes remain sequential and require the native approval flow and a successful receipt.
