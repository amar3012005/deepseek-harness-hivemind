# Brain runner user model connection

Brain retains its existing private session/agent loop. The native `agent/request` hook resolves
its authenticated execution principal and reuses the same user/workspace connection served by
Runtime's fixed shared bridge. No credentials enter prompts or browser state. No selected model
means the existing provider remains unchanged; a selected unavailable connection pauses work.

`codex-model-client.ts` and `codex-connection-protocol.ts` are the same native client contract
from the independent Runtime Runner shared-model-media implementation. They contain no agent loop,
OAuth storage, new public API or company-memory authority. Their byte identity is checked at release.
The deployment provides `HIVEMIND_CODEX_CONNECTIONS` plus the server service-secret reference.
No Core or Control release is involved. Text/tool inference requires separate live Brain receipts.
