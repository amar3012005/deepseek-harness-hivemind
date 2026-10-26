# Connected-app efficiency for Brain email drafts

Brain's connected-app turn for "draft a reply to this Gmail message using my memories" took about ten sequential calls: a failed recall, a repeated search and schema load, a second fetch after a projection dropped the message id, sender and body, a failed receipt read, and a draft with no recipient. This note records the bounded change that targets that flow.

## Decision
- **Schema cache:** authoritative provider schemas are cached per `orgId:userId`, toolkit, tool slug and schema hash, for `schemaCacheTtlMs` (default 3600000). Search stores the contracts it returns. A later search reuses a planned read's cached contract, and a `schemas` call answers from cache without a provider call when every slug is cached. Connection management, wait and delegated verification drop the tenant's entries.
- **Projection:** identifiers, readable evidence and attachment names are kept in every provider projection, including exact `result_fields` projections. Non-evidence payload is still omitted. Evidence keys do not count toward the 40-key cap.
- **Concurrency:** read-only connected actions and provider read verbs (`FETCH`, `GET`, `LIST`, `SEARCH`, `FIND`, `READ`, `LOOKUP`, `CHECK`, `RETRIEVE`) are concurrency-safe. A mutating verb or a non-read verb anywhere in the slug (such as `MARK_AS_READ`) keeps the call exclusive. `hivemind_meta` recall was already concurrency-safe in the memory package.
- **Recipient fill:** a draft or reply tool whose contract declares `recipient_email`, `to`, `to_email` or `recipient` receives the sender of the newest receipt that names the referenced `thread_id` or `message_id`. Fill happens only when exactly one sender matches. Approval runs before `execute`, so the `tools/pre-execute` reason names the same implied recipient the fill will use. Both read the same durable receipts. With full-access permission, no approval runs and the fill proceeds silently.
- **Recall:** one retry after 300 ms on a Core 503. Every recall logs one line with the route, status, attempt count and latency. The line carries no query text or credentials.
- **Approval gate:** `REPLY` and `FORWARD` join the mutating pattern. Before this change, `GMAIL_REPLY_TO_THREAD`, which sends mail, skipped the native approval gate. The client already labels it as a send.
- **Read receipt:** the error names each missing input and states when a receipt read is appropriate.

## Alternatives rejected
- Caching search results. Discovery stays per conversation because the planned set depends on the query text.
- Retrying every Core status. Only 503 is retryable here, matching `typedReadFailure`.
- Filling recipients from the fetch result without a receipt lookup. The receipt is the durable source, so a replay reproduces the same recipient.

## Consequences
- A first-time flow still needs search, then a schema load, then the read, then the draft. The cache removes the schema load on repeat use within the TTL, and the projection removes the second fetch.
- Repeated email drafts within the TTL use search then execute, which is one fewer provider call.
- Concurrency lets independent reads share a model step. Writes stay exclusive.

## Verification
- `packages/hivemind/connected-apps` vitest: 131 tests pass, including the schema-cache unit tests, the cache, concurrency and recipient cases, and a three-invocation reply flow.
- `packages/hivemind/runtime` vitest: the three new recall tests pass. One pre-existing assertion in `projects only completed user requests and final answers` fails and is not part of this change.
- `packages/preset/agent-presets` shipped-root tests: two pre-existing failures, reproduced with the committed preset file.
- `tsc -b` on connected-apps and runtime: clean.

## Open
- Confirm on singulance-engine that recall logs show `recall outcome route=/api/recall status=... attempts=... latency_ms=...`. A run of `status=503 attempts=2` means Core is unavailable, not a Brain bug.
- The Gmail draft recipient field differs between Composio versions. The fill targets whichever recipient property the contract declares.
