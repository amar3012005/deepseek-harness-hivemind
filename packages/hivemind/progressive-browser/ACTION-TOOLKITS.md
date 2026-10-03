# Native Cloudflare action toolkits

Runtime and HyperAgents contribute their action instructions to `ctx.skills`.
The existing `tool-skill` catalog and `skill` loader remain authoritative.
The browser plugin's standard `tools/post-execute` hook reveals exact tools
after a successful native load; its durable capability receipt restores that
agent's tools after reconstruction. Existing progressive discovery remains
compatible with older conversation instructions.

`browser-use` exposes `browser_markdown`, `browser_extract`, `browser_links`,
`browser_scrape`, and `browser_capture`. `parallel-search` exposes
`parallel_search`. Names, descriptions, and JSON input schemas were extracted
from Cloudflare Think 0.19.0 / Agents 0.24.0 and the original task-agent tools.
The original bounded results and Parallel request shape are retained.

The native plugin calls Cloudflare Browser Rendering REST and the existing
Parallel AI Gateway route directly. No legacy Task Agent, new Worker, new
reasoning loop, Core change, or control-plane change is required.
Capture explicitly requests PNG and saves the result through native
attachment storage. Provider errors remain errors; no simulated evidence.

Deployment-owned configuration: `actionAccountId`, `actionBrowserToken`,
`actionGatewayId`, and `actionGatewayToken`. Presets read the corresponding
`HIVEMIND_ACTION_*` environment variables. Credentials never enter model
arguments, results, source, or durable capability receipts.

Validation: targeted compilation and existing browser/skill tests; six real
provider calls passed for the SINGULANCE website. Authenticated native-room
loading and attachment persistence must also pass after the runner release.
