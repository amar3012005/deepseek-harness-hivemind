# Agent Note: Runtime clear scope and bounded discovery

Status: implemented

English | [中文](2026-10-13-runtime-clear-scope-and-bounded-discovery.zh.md)

## Problem

Runtime can postpone an explicit team request through redundant discovery and questions. Contract listing returns historical receipt collections and performs reconciliation, so declaring the entire operation concurrency-safe would permit overlapping mutations.

## Decision

Runtime and HyperAgent instructions recognize an explicit audience within the authorized roster, resolve routine reversible choices and ask only when missing evidence, authority or a material decision changes the next action. They permit independent concurrency-safe reads in the same native tool batch and retain ordered dependent reads, writes and shared browser operations.

Ordinary HQ contract listing reads saved current heads without room creation, artifact reconciliation or dispatch polling. A deployment-configured item/UTF-8 budget bounds the complete response. Exact task lookup and revision-bound pagination preserve access to saved work. Inspection and explicit dispatch refresh retain their serialized reconciliation. Native tasks, acceptance checks, history, UI and authorization remain their existing owners.

## Alternatives considered

- Merely instructing parallel reads leaves the mutating list path unsafe.
- Marking every contract action concurrent permits conflicting assignment and review writes.
- A separate planner, task database or dispatcher duplicates native ownership without addressing the observed discovery overhead.
- Removing questions entirely prevents necessary human decisions and genuine approvals.

## Consequences

Discovery returns abbreviated current records, counts and pointers; artifact inspection supplies complete evidence. A changed roster or board requires a new first page, while unrelated tool results do not invalidate pagination. An item that cannot fit the complete byte budget fails explicitly. The real Loader/AgentLoop fixture checks first-request guidance, overlapping read execution and durable results. These fixtures establish composition and concurrency, not ordinary-model production completion.
