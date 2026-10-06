# HIVEMIND App Builder

Optional Cordis consumer for the Core App Runtime v1 API. It registers native tools when explicitly mounted; it does not replace the agent loop or employee lifecycle. Runtime and HyperAgent presets mount it only when `HIVE_APP_RUNTIME_ENABLED=true`. The native skill registry owns its on-demand `create-crm` guidance.

## Tools

| Tool | Operation |
| --- | --- |
| `hivemind_app_create_draft` | Create a data-only AppSpec draft with a stable operation ID |
| `hivemind_app_get` | Read current spec and version |
| `hivemind_app_patch` | Replace the complete spec using expected-version comparison |
| `hivemind_app_validate` | Ask Core to validate the persisted spec |
| `hivemind_app_preview` | Read declarative preview data; does not install a renderer |
| `hivemind_app_publish` | Publish an immutable version with server publication authorization |
| `hivemind_app_query_records` | Read up to 25 entity records with a cursor |
| `hivemind_app_create_record` | Create typed record data with an operation ID |
| `hivemind_app_update_record` | Update record fields with version comparison and an operation ID |

The tool dialect uses closed input objects and the native `validateJsonSchemaValue` executor validation. Output declarations validate canonical app, record, validation and page envelopes. AppSpec tool schema is generated from Core `core/src/app-runtime/contract.js` export `APP_SPEC_TOOL_SCHEMA`, schemaVersion 1. Core remains authoritative for identifiers, limits, referenced entities, migration checks, record types and tenant membership. Keep the generated schema synchronized when that version changes; it is not imported across repositories at runtime.

## Authority and recovery

Deployment supplies `serviceApiBase`, `serviceSecretEnv`, `requestTimeoutMs`, `maxRequestBytes` and `maxResponseBytes`. Defaults are declared by the exported Cordis Config. Scoped-service authority requires the existing execution-scope plugin. Requests derive user and organization claims from that authenticated scope and sign the existing 30-second Harness-to-Control JWT. Models cannot choose a tenant, token, origin or route. Redirects are refused; HTTP is allowed only for loopback or the existing Control Plane Compose service names. Responses are streamed with a byte limit and native tool cancellation.

Writes require a stable `operation_id`; no automatic retries generate new identities. Interrupted writes report unknown outcome. Reconcile current state or repeat the exact payload and operation ID against Core's durable idempotency receipts. Expected-version conflicts require reading the current version before preparing another edit. Validation diagnostics expose approved error codes and bounded field paths, without reflecting server stacks or auth errors.

## Future integration

The resolver manifest and Runtime/HyperAgent presets include this package behind `HIVE_APP_RUNTIME_ENABLED=true`; ordinary Brain chat does not mount it. Before enabling the flag, mount the opt-in Core App Runtime handler, apply its SQL migration, and authorize its routes in the existing Control gateway. Project-scoped sessions are rejected before JWT signing because App Runtime v1 is organization-scoped. Production activation is not part of this integration.

An eventual `@create CRM` UI entry can hand the raw request to the existing Runtime or HyperAgent. Supply build guidance through the existing progressive-skills or native skill provider rather than injecting the full AppSpec catalog every turn. The model should create, validate and preview a draft before authorized publication. Da Vinci should render approved Table, Kanban and Record components from published specs; arbitrary React, SQL and JavaScript execution are unsupported.

## Model Experience

No model requests or prompt contributions occur inside this plugin. Feature-enabled mounting adds nine tool schemas to the selected scope; repeated full specs increase token use, so get and preview should be task-scoped. Record reads are bounded, and idle tools should stay out of unrelated scopes through existing composition or capability leasing. The package neither modifies model selection nor compaction and introduces no prefix-cache invalidation beyond the tool schemas of an explicitly changed composition.

## Known Limitations and Deferred Work

Feature-disabled compositions do not mount these tools; no production routes are enabled by this change. The registered skill becomes discoverable only in an enabled Runtime/HyperAgent scope. There is no connector execution, automation engine, relation mutation API, filtered record query, bulk mutation or data migration executor. Published CRM fields are not a replacement for Company Brain memories. Host presenters use generic native cards; dedicated preview cards belong to future frontend integration. No invariant companion is provided: this consumer has no independent replicated state to compare; Core owns durable versions and receipts.
