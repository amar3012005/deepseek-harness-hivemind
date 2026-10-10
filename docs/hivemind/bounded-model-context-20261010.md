# Persistent company chats with bounded model replay

## Diagnosis

Read-only production inspection of Ravi's failed request through event 2223 confirmed
`cloudflare-openrouter-streaming / openai/gpt-6-luna`, generation cap 32768.
The native folded surface had 718 message nodes totaling 5,815,104 serialized
characters. There were no compaction or prune events before that failure.
The largest tool-result block was 49,896 serialized characters; the latest
memory result was 17,749 characters. Large assistant messages also accumulated
across old work. This is accumulated replay, rather than only one enormous current
memory answer. Serialized character counts are not provider token usage.

Saved provider usage at assistant event 2214 reports 929,509 prompt tokens
(3 input + 929,506 cache-write), and event 2453 after recovery reports 611,875
(3 input + 7,261 cache-read + 604,611 cache-write). The latter does not exceed
the default native pressure gate: the model's catalog window is 1,050,000,
so an 80% gate is 840,000 and a 16% retained tail is 168,000. Native compaction
and pruning are now mounted by the shared HIVE Chat preset (inherited by Runtime
and HyperAgents); disabled web-host entries deliberately leave ownership to these
presets. This change addresses that effective policy, without changing the model.

## Change

Use existing native token measurement, surface compaction checkpoints, and tool
result pruning. Add optional `thresholdTokens` to native compaction's existing
policy: the lower of the model-relative threshold and this absolute cap triggers
pressure maintenance. Other presets retain their original defaults.

All company presets inherit:

- pressure: lower of 65% of the actual model window and 48,000 tokens;
- recent verbatim tail: 12,000 tokens, with native tool-pair boundary handling;
- summary output: 4,096 tokens;
- existing native text-result pruning: 8,192 character threshold, head/tail retained.

The summarizer explicitly preserves latest intent, sender/organization attribution,
task owners and identifiers, checkpoints, blockers, pending questions, accepted
results, and verified approvals. An employee recommendation remains distinct from
human authorization. No alternate session manager, destructive history deletion,
new memory store, model selection, or changed authority boundary is introduced.
Full original messages/results remain in the immutable log; replacement checkpoints
and prune events affect only model replay. Native retrieval can inspect saved
original evidence when needed. Relevant memory is still explicitly retrieved by
existing bounded recall tools, rather than automatically replaying the database.

## Verification

Native compaction/pruner suites: 149 passing checks, including pairing, cancellation,
overflow recovery, durability and cold restoration. Company preset composition:
12 passing checks confirming Runtime and HyperAgents inherit the same budgets.

One deterministic 80-exchange native fixture measured **325,789 -> 12,360** tokens
of pressure. It preserved the newest human message verbatim, every original event,
and the same model surface and token measure after cold restoration. Its local
checkpoint operation took about 3.5ms with a stub summary; **this is not live model
or user response latency**. Real compaction entails an additional model call.

The configuration catalog generator was attempted but blocked by 21 pre-existing
JSDoc completeness violations in unrelated company events. No generated catalog
was manually altered. Owner compilation/push results are recorded in the release
handoff.

## Release and remaining evidence

Integrate the commit onto the current runner base, preserve the separate reset
fixes, compile compaction-basic and agent-presets, rebuild the immutable runner,
and perform a serialized runner-only cutover. No backend migration is required.
This task has not deployed or modified real chat data.

Verify a long-lived fictional Runtime and employee chat before claiming production
latency improvement: measure native pressure before/after, inspect checkpoint
source, continue pending questions/tasks, restart and reload, and check current
human intent and authenticated source remain correct. Existing Ravi history can
be compacted through the native maintenance command under release ownership;
never reset it to achieve a smaller request.

48k is a **maintenance threshold, not an unconditional hard request cap**. A very
large indivisible current exchange, system/tools envelope, or failed summary can
still exceed it; native code keeps pairing/authority intact and reports pressure.
Early maintenance prevents ordinary accumulated history from reaching the current
hundreds-of-thousands scale. Initial maintenance of existing huge history can itself
be costly; live provider timing and one resumed Ravi request remain release checks.
