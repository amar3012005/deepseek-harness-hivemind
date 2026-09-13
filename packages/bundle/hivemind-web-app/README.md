# @deepseek-ai/dsh-hivemind-web-app

Final bundle layer for `dsh --profile hivemind-web`. It starts from the complete native Web bundle and retains its chat, Session, conversation, attachment, approval, model, plan, question, goal, tool, job, subagent, trajectory, and deliverable presentation surfaces. HIVE-specific layout remains a later reversible browser overlay; this bundle does not unregister native renderers.

The layer selects the `hivemind-chat` agent preset, replaces JSONL SessionPersistence with the tenant-scoped PostgreSQL provider, mounts embedded ticket authentication, and exposes `/health`. Standard `web` and all other shipped profiles remain unchanged.

## Model Experience

### HIVE Web model defaults

#### What the model sees

The HIVE model receives the `hivemind-chat` persona, native tool guidance, direct tool schemas, and progressive context. This bundle disables the generic Harness identity and developer Web context, including checkout paths and local server instructions, using existing profile options. Native tool registration and agent continuation remain available.

#### Token effect

Developer instructions are omitted from each model request. The default model maps Harness reasoning effort `off` to provider value `none`, so optional provider reasoning is disabled rather than merely hidden. Other configured reasoning efforts remain selectable. Task completion follows requested evidence rather than a prompt-imposed call count.

#### KV Cache effect

The reasoning default and model roster are stable profile configuration. Task-dependent HIVE context is appended by the owning runtime after the reusable prefix.

## Known Limitations and Deferred Work

Changing the reasoning effort in an existing session takes effect at the next native model-selection boundary; it does not rewrite an in-flight request.
