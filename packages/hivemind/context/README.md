# @deepseek-ai/dsh-hivemind-context

Projects bounded completed user/final-answer exchanges and keeps detailed capability discovery out of the first HIVE model request. Internal tool calls and tool outputs are removed from later ordinary requests.

The native Harness skill catalog stays registered, but is withheld until the model calls the configured capability-request tool in the current turn. The next native Harness step then receives that catalog without a prompt classifier or a replacement planner. Current-turn nodes remain outside the history replacement interval, and an interrupted latest turn is not compacted. Original events remain available for replay and workflow restoration.

## Model Experience

### On-demand HIVE context projection

#### What the model sees

The first step receives bounded completed user/final-answer exchanges and any unfinished current-turn workflow state, but no native `skill-catalog` message. After `hivemind_capabilities` has a durable call in the same turn, the next step receives the unchanged native catalog.

#### Token effect

Direct answers and concise clarifications avoid catalog tokens. Later ordinary turns retain at most the configured completed exchanges; old reasoning and tool payloads stay durable but leave model input.

#### KV Cache effect

The stable system and tool prefix remains unchanged. Capability discovery appends one bounded tool exchange and the native catalog only when requested.

## Known Limitations and Deferred Work

The plugin filters only messages whose native source kind is `skill-catalog`. It does not alter tool registration, tool execution, session events, or the agent loop.
