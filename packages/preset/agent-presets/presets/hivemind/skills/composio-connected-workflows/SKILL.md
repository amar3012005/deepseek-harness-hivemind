---
name: composio-connected-workflows
description: Load for complex multi-app dependencies, partial-failure recovery, or durable connection/approval resumption. Simple single-app reads and writes use hivemind_connected_task search directly without this skill; routine destination discovery is part of the same task.
---

# Composio connected workflows

Use `hivemind_connected_task` for current mailbox, calendar, CRM, Slack, social,
or connected-drive work. HIVE memory and connected applications are separate
evidence sources.

## Progressive sequence

1. Call `search` immediately, before asking any clarification question, with
   `session: { generate_id: true }`. Missing destinations, recipients, folder
   IDs, and similar discoverable inputs are hidden prerequisites: add a separate
   atomic query to discover them. Do not ask the user for a Slack channel,
   mailbox identifier, calendar ID, or other provider-owned value before search
   has reported connection status and the available discovery tools.
   Put each independent
   action or hidden prerequisite in its own `queries` item. Each `use_case` must
   name the app when supplied or established; otherwise describe the service
   and let discovery resolve it from authenticated active connections. Never
   invent a provider to populate an optional search field. State the
   operation, filters, ordering, result limit, and
   required fields. Put only 1-2 short identifiers in `known_fields`.
   Use the exact requested result limit: latest means one, and an explicit count
   means that count. Do not over-fetch merely to inspect alternatives.
2. Follow the returned `recommended_plan_steps`, `known_pitfalls`, connection
   statuses, and selected tool slugs. Never invent a slug or load a broad catalog.
3. Use the exact `execution_contracts` returned by search. Call `schemas` only
   for selected tools needed by the next bounded step whose contracts are absent.
4. Search automatically returns `status: "connection_required"` with a
   session-bound authorization banner when a selected app is disconnected. Stop
   planning immediately. The native connection receipt ends the turn and owns
   the authorization UI; do not duplicate it with `ask_user_question` or a final
   explanation.
   Do not search again or inspect unrelated tools while connection is pending.
   After the user continues, call `wait_connection` once with the same session
   id and toolkit and proceed only when the server verifies an active connection.
   This connection gate always precedes user clarification about provider-owned
   destinations or recipients. Once connected, use the selected read tool to
   enumerate valid choices, then ask only when the user truly must choose among
   them.
5. Reuse the returned session id for every later meta-tool call. Execute only
   selected tools. Keep dependent work sequential. Independent
   reads may be grouped only when each result is separately attributable.

## Identity and durable work

The runtime derives organization and user identity from authenticated HIVE
admission. Never pass tenant IDs, user IDs, connection IDs, or credentials from
chat. Keep a durable plan for multi-step work and preserve provider receipts so
reload and replay show what completed, failed, or still requires action.

## External changes

Reads may execute after policy authorization. Sends, posts, edits, deletes,
publishes, invitations, payments, uploads, and other mutations must first create
an editable HIVE PendingWrite. The connected-app discovery bridge only prepares
mutations; the governed-action service executes a current server-approved draft
with its idempotency key. A draft is not a completed external action.
Revalidate recipients, destinations, connection state, and approval immediately
before execution. Report partial success per destination without retrying an
already completed idempotency key.
