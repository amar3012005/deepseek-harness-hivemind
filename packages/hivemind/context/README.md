# @deepseek-ai/dsh-hivemind-context

Projects a compact organization brief and bounded completed user/final-answer exchanges. Internal tool calls and tool outputs are removed from the next request.

Completed history is projected even when no profile was injected. Current-turn nodes remain outside the replacement interval, and an interrupted latest turn is not compacted. Original events remain available for replay and workflow restoration.

## Model Experience

- **Visible tools:** none.
- **Prompt cost:** the configured compact brief and recent final exchanges only.
- **KV-cache effect:** stable routing text precedes task-dependent context.

## Known Limitations and Deferred Work

The authenticated snapshot provider is composed by the compatibility runtime.
