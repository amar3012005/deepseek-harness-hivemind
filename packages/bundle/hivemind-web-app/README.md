# @deepseek-ai/dsh-hivemind-web-app

Final bundle layer for `dsh --profile hivemind-web`. It starts from the complete native Web bundle and retains its chat, Session, conversation, attachment, approval, model, plan, question, goal, tool, job, subagent, trajectory, and deliverable presentation surfaces. HIVE-specific layout remains a later reversible browser overlay; this bundle does not unregister native renderers.

The layer selects the `hivemind-chat` agent preset, replaces JSONL SessionPersistence with the tenant-scoped PostgreSQL provider, mounts embedded ticket authentication, and exposes `/health`. Standard `web` and all other shipped profiles remain unchanged.
