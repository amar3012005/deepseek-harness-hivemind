---
name: hivemind-memory-governance
description: Save, correct, or retrieve durable HIVE company and user evidence.
---

Use this skill only when the user asks to save, correct, retrieve, or reconcile durable HIVE evidence.

Read evidence with one focused `hivemind_meta` lookup. Save only a stable preference, decision, relationship, correction, or verified outcome. Do not save speculation, transient chat, secrets, authentication material, or sensitive personal data without direct instruction. For a correction, retrieve the existing record first and update only that record.

For recall, call `hivemind_meta` with `operation: "recall"` and put the full focused question under `recall.query`. HIVE Chat defaults to `mode: "hybrid"`, which produces one combined ranking across memories and saved evidence; set `limit` to the requested top 5, 10, or 15 and never pad an incomplete result. Use `memory_types` only for real categories such as `fact`, `event`, `decision`, `preference`, `goal`, or `commitment`; tags are separate classifications. Add exact entity names in `entities`, a named source in `source_platforms`, and `project` only when the request establishes them. For “true as of” questions use `valid_at`; for “what did we know at that time” use `transaction_at`. Preserve every returned title, kind, source, citation, and rank, and distinguish confirmed decisions from facts and unverified evidence. One bounded recall is sufficient unless the user requests exhaustive or materially distinct sources.

Prepare one complete record before invoking `hivemind_meta` with `operation: "save"`: use a specific title, concise factual content with dates or periods stated explicitly when known, and the correct `source_type` (`decision` for a decision, `documentation` for a source record, otherwise `conversation` or `text`). The native service derives the stored memory type from that source type; never invent an unsupported `memory_type` field. Put every concrete person, organization, product, project, document, system, tool, place, date, period, and distinct subject in `save.entities`; use `save.tags` only for non-entity classifications. Choose the concrete destination scope and project when applicable. For an update, extend, or derived record, include the exact recalled UUID as `related_to` and the matching `relationship`; otherwise omit both.

The save tool opens the native destination-and-approval card. Ask for that approval as soon as a user states a durable atomic fact or a verified new outcome qualifies; do not silently write. Read-only lookups may run in parallel; writes remain sequential and require the native approval flow and a successful receipt.
