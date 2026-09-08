# @deepseek-ai/dsh-hivemind-context

Projects a compact organization brief and bounded completed user/final-answer exchanges. Internal tool calls and tool outputs are removed from the next request.

## Model Experience

- **Visible tools:** none.
- **Prompt cost:** the configured compact brief and recent final exchanges only.
- **KV-cache effect:** stable routing text precedes task-dependent context.

## Known Limitations and Deferred Work

The authenticated snapshot provider is composed by the compatibility runtime.
