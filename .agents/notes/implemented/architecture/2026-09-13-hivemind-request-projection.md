# HIVE connected-app request projection

The HIVE profile begins with only its stable system contract, bounded completed exchanges, unfinished durable workflow state, and registered gateway capabilities. The native skill catalog remains absent until `hivemind_capabilities` is called. This behavior is owned by HIVE profile and projection plugins and does not modify the Harness agent loop or session log.

Authenticated profile and organization detail is deliberately on-demand through `hivemind_meta context`; it is not inserted before the first model step. This keeps ordinary greetings, direct answers, and connected-app work from paying for profile context they do not use, while preserving the authenticated server-side source for a later context receipt.

Connected-app discovery stores the original Composio response in private spill storage before returning a model-visible projection. That projection contains the workflow session, connection state, selected tools, required planning guidance, and exact execution contracts. Completed provider execution clears the unfinished-workflow projection on later turns.

Native approval rejection and cancellation are terminal outcomes for the proposed write. Their durable error receipts clear the unfinished projection, preventing a rejected write contract from entering unrelated later requests. Provider execution failures remain resumable because they may require recovery with the same selected contract.

Each atomic connected-app query may declare exact provider `result_fields`. The bridge retains those field names with the conversation-scoped workflow without sending them to Composio search. After provider execution, only matching fields and their structural containers enter model context; the full receipt remains privately retrievable. When no declared field matches, the bridge returns its existing bounded evidence projection rather than silently removing required information.
