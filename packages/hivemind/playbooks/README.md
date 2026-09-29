# @deepseek-ai/dsh-hivemind-playbooks

Provides progressive company operating playbooks to the HyperAgents preset without adding every playbook body to the system prompt.

The `hivemind_operating_context` tool prepares a compact company-work discovery pass when deeper evidence or execution choices could materially improve the outcome. It records a run identity, bounded company evidence, compatible global and local method candidates with their guidance, compact employee capability cards, and capability guidance. It does not activate employee personas or create an execution gate. Candidate selection retains the best local method beside its global doctrine instead of filling the compact window with global entries alone. Field methods identify their guidance tool and capability lane. The model may use the receipt directly, load a useful method, record an intent receipt, or continue with any native Harness capability.

The `hivemind_playbooks` tool supports three operations:

- `search` returns a bounded compact candidate list from the task objective, optional level, and optional domains.
- `load` returns complete content for selected playbook IDs and appends `hivemind/playbooks-loaded` before that material is visible to the next model step.
- `record_plan` appends `hivemind/run-plan`, recording the task-local objective, selected versions, reasons, and adaptive approach.

Each local method declares compatible global doctrine. Loading a local method automatically includes one compatible global doctrine when the model omitted it, which lets compact model routes make a useful selection without constructing a dependency graph. The selected method bodies are therefore available before the model records its concise plan.

Global playbooks describe cross-task operating doctrine. Local playbooks describe reusable methods for recurring work. Search returns no candidate when the catalog has no relevant match, and the agent loads a method only when it improves the requested work. If no playbook fits, native Harness reasoning continues without inventing or publishing a speculative permanent playbook. The compact `hivemind_operating_plan` remains visible in the initial HyperAgents capability set so a substantial company task can record selected methods and optional actor choices immediately after operating context. Recording employee workstreams progressively reveals the original workstream and employee tools required to execute those choices; bounded work can skip the receipt.

The investor-deck method keeps compliance, market, financial, and company claims traceable to receipts or explicit assumptions, encourages distinct employee assignments where they add expertise, and treats a requested deck as an artifact outcome rather than permission to return a generic outline.

The package is mounted only by the HyperAgents presets and does not modify the native agent loop, shipped presets, skill registry, workflows, or session persistence. Bounded company questions, drafting, transformation, and synthesis remain direct native Harness work. Plans, methods, employees, research, and workstreams are optional model-selected capabilities rather than a workflow graph; native tool, job, workflow, browser, artifact, and employee receipts remain the execution record.

Capability leases separate ordinary operating controls from high-cost automation. A recorded plan may retain playbooks, workstreams, and native todo tracking, while workflows, goals, and Ralph stay in the explicit `automation` lane until the model identifies a durable automation need. When a progressive provider registers original scoped tools after discovery, the prompt projection reads the effective agent-scoped registry so those definitions remain visible for the following model step. This prevents a browser-discovery loop without widening the initial tool catalog.

`employeeSubagentPlanning` is a preset-level choice. Its default preserves employee child-session planning. HyperAgents Compressed disables that actor kind and does not mount the employee-delegation consumer: authenticated employee assignments remain visible `inline_employee` workstreams, the parent runtime executes them through `hivemind_workstream`, and the operating plan's native todos track completion. Native Harness subagents remain installed for non-employee work, so this changes employee projection without replacing the agent loop.

## Verification

Run `pnpm exec vitest run packages/hivemind/playbooks/tests/playbooks.spec.ts` and `pnpm run verify-cordis-config -- --preset hyperagents`.
