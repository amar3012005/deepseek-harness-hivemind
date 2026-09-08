# @deepseek-ai/dsh-hivemind-virtual-workspace

HIVE-only provider for Harness's `workspaceRegistry` service. It deliberately exposes no filesystem workspaces while satisfying the native session controller's service dependency. Session creation, streaming, persistence, replay, forking, tool cards, and approvals remain native; HIVE public sessions are simply unattached to a host path.
