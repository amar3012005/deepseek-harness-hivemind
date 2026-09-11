# HIVE-MIND Composio visible progress

The HIVE connected-app plugin keeps `hivemind_connected_task` as its single model-facing progressive router. Composio meta-tool calls remain implementation details of that tenant-scoped tool, while their names and completion states are recorded in the tool result so the native keyed tool view can project search, connection, schema, wait, and provider progress during replay.

Each agent turn may perform one connected-app search. A connection-required result is authoritative for that turn: later model steps cannot spend another discovery request and must follow the returned connection state or wait for new user input. This limit is owned by the connected-app plugin and does not change the native agent loop or unrelated tools.

The server-side Composio session continues to derive its identity from the authenticated HIVE user. Search receipts retain selected slugs, connection status, planning guidance, and the private spill reference; provider credentials and tenant identifiers never enter model-visible arguments.
