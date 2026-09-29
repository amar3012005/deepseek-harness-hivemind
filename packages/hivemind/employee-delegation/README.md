# @deepseek-ai/dsh-hivemind-employee-delegation

Creates a bounded native Harness subagent run from an authenticated HIVE-MIND employee directory entry. It is mounted only by the HyperAgents preset.

## Model experience

The model receives `hivemind_delegate_employee` and `hivemind_employee_panel` only after the HyperAgents employee capability is selected. They are escalation paths, not the normal employee representation: ordinary employee perspectives run inline through `hivemind_workstream`, keeping the parent Harness context and token budget. The single-employee tool accepts an exact employee ID, a self-contained task, and one optional desired outcome. The panel accepts two to five independent assignments with those same fields and starts their native children concurrently when the operating plan materially needs isolated child sessions. Neither tool asks the model to construct organization scope, policy, credentials, persona bodies, budgets, playbook state, or audit metadata.

The parent log records a delegation-start snapshot before the child starts and a paired terminal event whether startup rejects or the child settles. The default foreground native child returns its bounded result in the same tool step, which avoids completion polling and repeated parent-context requests while still publishing a real child session. Deployments can opt into `runInBackground`; that path uses Harness jobs unchanged, returns the job ID, and relies exclusively on the native completion notice plus `job_output` contract.

The frozen child assignment tells the employee not to repeat parent orientation. If the assignment requires current external evidence, the child may lease research once, perform one bounded parallel `hivemind_research_gather`, and synthesize from that receipt. This keeps specialist autonomy while preventing an employee from spending its entire duration on sequential search/fetch refinement.

When an operating plan selects more than one employee child, its execution receipt recommends one panel call instead of sequential delegation calls. Every panel member retains an ordinary delegation start/end pair linked by a shared panel ID. One member can fail without discarding successful handoffs, and a completed panel cannot be repeated under the same plan revision.

## Boundaries

- Every authenticated directory entry can run in HyperAgents mode. HIVE-MIND lifecycle status is preserved in the source profile but is not an execution gate here.
- Harness derives the frozen assignment server-side: persona, role, profile version, acceptance criteria, selected global/local playbooks from the latest run-plan event, parent session/plan linkage, duration/depth/output-token budgets, effective child-tool denial, and digests of profile policy, persona contract, profile tools, and persona. Later employee edits do not reinterpret a completed run, while raw policy and persona bodies do not inflate the parent transcript.
- The configured output ceiling is passed through native `agentOptions`; the configured duration is an abortable native child-run boundary. The receipt marks acceptance as `unreviewed` because the adaptive parent runtime—not this plugin—judges whether the returned work satisfies the company task.
- Every attempted delegation has one UUID pairing its start and terminal events. Startup rejection and abnormal child settlement remain visible as failures; terminal events retain an output digest and size without copying the child answer into log-only audit metadata.
- The initial provider is a one-shot native `spawn` with maximum nesting depth one.
- Recursive delegation, workflow, and Ralph tools are denied to the child. Profile tool grants and model-route mappings remain a server-side policy extension; arbitrary profile strings are not treated as native Harness tool names.

## Verification

Run `pnpm exec vitest run packages/hivemind/employee-delegation/tests/employee-delegation.spec.ts packages/hivemind/playbooks/tests/playbooks.spec.ts` and `pnpm run verify-cordis-config -- --preset hyperagents`.
