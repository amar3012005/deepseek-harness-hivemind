# HIVE-MIND governed research

English | [中文](README.zh.md)

This package exposes provider-neutral governed research to HyperAgents. `hivemind_research_answer` is the normal task tool for a current multi-source question: it owns one bounded evidence task, runs its independent questions concurrently, and returns one citation-ready receipt for parent synthesis. `hivemind_research_request` handles one focused or dependent investigation, while `hivemind_research_gather` remains the lower-level tool for operating runs that have already separated independent objectives.

The gather tool is bounded by `maxGatherObjectives`, `maxGatherSources`, and the existing per-objective result and excerpt limits. One failed lane produces a partial receipt when another lane has evidence. The task tool records `hivemind/research-workflow-started` and one terminal `hivemind/research-workflow-terminal` event; a completed task cannot be reopened in the same user turn. A new user turn can intentionally request fresh evidence. It does not create an LLM child, alter the native agent loop, or hide provider failures. Pending remote work remains owned by native jobs and durable research receipts. Presets can set `exposeAdvancedTools: false` to expose only `hivemind_research_answer`; the internal bounded gather remains available to that stable task tool. `injectTerminalReceipts` is for asynchronous research whose terminal receipt arrives without a native tool result. A preset with inline terminal research can disable it and let Standard's ordinary tool-result continuation synthesize directly; HIVE-MIND Code uses that mode.

## Model Experience

For a current multi-source question, the model calls `hivemind_research_answer` once, adds only materially independent questions, and synthesizes from its terminal receipt. It does not poll, create a todo or plan, or call raw web tools unless the receipt records a specific evidence gap. The lower-level gather, single-request, and status tools remain available for operating runs and genuinely dependent work.
