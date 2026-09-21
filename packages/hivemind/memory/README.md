# @deepseek-ai/dsh-hivemind-memory

English | [中文](README.zh.md)

Provides progressive `hivemind_meta` reads and approval-gated memory saves. Providers can also expose `hivemind_update_profile` for the caller's descriptive profile facts. Tenant scope remains server-derived. Recall supports focused source, project, time, tag, media-kind, filename, and entity filters without accepting a tenant identifier.

The tool registration is owned by the plugin fiber through a Cordis effect. Reloading or disposing the HIVE plugin therefore removes its tool instead of leaving a duplicate or stale registration in another profile.

## Model Experience

- **Visible tools:** compact meta-tool, memory save, and optional profile update.
- **Prompt cost:** bounded schemas; evidence appears only after invocation.
- **KV-cache effect:** stable tool schema.

## Recall filters

`recall` always requires a focused `query`. Use `source_platforms`, `project`, time fields, `sort`, or `tags` only when the request supplies a relevant constraint. `media_kind`, `filename`, and `entities` are convenience inputs for internal media discovery; the tool converts them to the server's `kind:*`, `filename:*`, and `entity:*` tags. A recall result is evidence metadata, not a local filesystem path or a retrievable binary artifact.

## Known Limitations and Deferred Work

Profile updates show the exact fields through native user questions before writing. Cancel leaves the profile unchanged. Completed receipts are replayable; profile audit events are ignorable for readers without this plugin. Descriptive role and company fields never change access permissions or login credentials.

Progressive recall pagination beyond the initial bounded result is deferred.
