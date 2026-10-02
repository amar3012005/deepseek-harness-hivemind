# Runtime and employee messaging

Native references were read through the DSH documentation MCP at revision
`639ed015397290b3745d163aafe02ffee4aa3f84`: `subsystems/agent-team.md` lines
137-225 and `tool-catalog.md` lines 2117-2143. Team mailbox authority is exact
Team membership; subagent send_message targets direct parents/children, not
arbitrary persistent rooms. Native send_message wakes idle recipients.

The additive HIVE plugin exposes one `hivemind_agent_message` tool for
persistent employee rooms. It validates the authenticated directory, uses
SessionController's existing persistent room opening, and admits questions
and replies through Agent.steer. It does not replace the native agent loop,
Team task board, subagent messaging, Schedule, or permission machinery.

Quiet updates append a native notice-form user/message and checkpoint it
without calling Agent.steer or adding an inbox item. Saved artifacts and
delivered human-requested responses reconcile into Runtime notices. Response
completion is explicitly distinct from verified task/external-action completion.

Sender outbox, receiver receipt and delivered acknowledgement are Session
log events. Stable message keys reject conflicting reuse; native inbox/history
acceptance suppresses repeat admission after an uncertain flush. Replies must
reference an incoming message from the target room. Exchanges stop after eight
linked hops. Room lookup captures authenticated persistence scope; no model
input supplies user or organization ids. Delegated children retain Team tools.

Core credit validation now accepts native UUID session ids as well as existing
session-prefixed ids. Control uses the same route module and therefore needs
the same immutable source image. No authority, tenant, credit, or control policy
is changed. Failed Team provisioning can receive at most two deterministic
admission-only retries, each requiring durable proof that no message, model,
tool, or artifact work was accepted. Uncertain effects stay blocked.

Production verification remains pending until recorded in the release report.
