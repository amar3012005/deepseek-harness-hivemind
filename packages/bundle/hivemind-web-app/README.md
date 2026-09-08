# @deepseek-ai/dsh-hivemind-web-app

Final bundle layer for `dsh --profile hivemind-web`. It retains the native Web chat, Session, conversation, attachment, approval, model, plan, question, goal, and generic tool presentation while removing workspace, sidebar, filesystem, shell, and developer-settings surfaces from this profile only.

The layer selects the `hivemind-chat` agent preset, replaces JSONL SessionPersistence with the tenant-scoped PostgreSQL provider, mounts embedded ticket authentication, and exposes `/health`. Standard `web` and all other shipped profiles remain unchanged.
