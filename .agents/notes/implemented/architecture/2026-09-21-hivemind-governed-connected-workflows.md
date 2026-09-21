# HIVE-MIND governed connected workflows

The HIVE-MIND profile keeps connected-app execution generic. JEV selects a bounded capability; it does not choose provider-specific actions, generate tool arguments, or execute tools. The native Harness receives the permitted schema family, discovers the connected workflow through Composio, and remains responsible for planning and execution. Do not add Gmail or other application-specific routing branches.

Connected workflow results persist a compact `hivemind/connected-receipt` event. The latest receipt is restored as bounded model context on later turns, and nested provider workflow identifiers are promoted to the receipt's top-level `session_id`.

Memory reads may run concurrently. Every mutation is exclusive. `hivemind_batch_save_memories` validates all entries first, requests one governed approval for the batch destination, and then saves sequentially. Authentication material, including one-time codes, recovery links, and security alerts, is rejected before approval or persistence.

Runner replacement must query the authenticated drain endpoint and observe zero active turns twice before recreation. A one-time legacy bootstrap exists only for upgrading a runner that predates the drain endpoint.

The chat UI keeps completed-turn actions visible and offers deterministic follow-up prompts without another model inference. It continues to render transport chunks immediately; upstream model or gateway buffering must not be disguised with synthetic typewriter output.
