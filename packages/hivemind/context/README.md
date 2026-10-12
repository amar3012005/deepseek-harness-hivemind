# @deepseek-ai/dsh-hivemind-context

Projects a bounded authenticated profile brief, completed user/final-answer exchanges, and on-demand capability discovery. Internal tool calls and tool outputs are removed from later ordinary requests.

The profile brief loader runs on the first turn and later direct profile or company questions. Its server-owned version is refreshed per relevant turn, while an unavailable optional brief never blocks the user request. The native Harness skill catalog stays registered, but is withheld until the model calls the configured capability-request tool in the current turn. The next native Harness step then receives that catalog without a replacement planner. Current-turn nodes remain outside the history replacement interval, and an interrupted latest turn is not compacted. Original events remain available for replay and workflow restoration.

## Model Experience

### On-demand HIVE context projection

#### What the model sees

The first step receives the bounded authenticated profile brief, completed user/final-answer exchanges, and any unfinished current-turn workflow state, but no native `skill-catalog` message. A later direct profile question receives a refreshed brief. After `hivemind_capabilities` has a durable call in the same turn, the next step receives the unchanged native catalog.

#### Token effect

Direct profile answers avoid an extra context tool round trip, while direct answers and concise clarifications avoid catalog tokens. Later ordinary turns retain at most the configured completed exchanges; old reasoning and tool payloads stay durable but leave model input.

#### KV Cache effect

The stable system and tool prefix remains unchanged. Capability discovery appends one bounded tool exchange and the native catalog only when requested.

## Known Limitations and Deferred Work

The plugin filters only messages whose native source kind is `skill-catalog`. It does not alter tool registration, tool execution, session events, or the agent loop.
