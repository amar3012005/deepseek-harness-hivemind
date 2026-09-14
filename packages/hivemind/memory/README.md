# @deepseek-ai/dsh-hivemind-memory

Owns the single `hivemind_meta` tool. It progressively selects company context, bounded recall, governed saves, or the exact HyperAgent directory while tenant scope remains server-derived. Recall supports focused source, project, time, tag, media-kind, filename, and entity filters without accepting a tenant identifier.

## Model Experience

- **Visible tools:** one compact meta-tool.
- **Prompt cost:** one schema; evidence appears only after invocation.
- **KV-cache effect:** stable tool schema.

## Recall filters

`recall` always requires a focused `query`. Use `source_platforms`, `project`, time fields, `sort`, or `tags` only when the request supplies a relevant constraint. `media_kind`, `filename`, and `entities` are convenience inputs for internal media discovery; the tool converts them to the server's `kind:*`, `filename:*`, and `entity:*` tags. A recall result is evidence metadata, not a local filesystem path or a retrievable binary artifact.

## Save relationships

A new standalone memory omits both `relationship` and `related_to`. `update`, `extend`, and `derive` are allowed only when the model has an exact existing memory UUID from recall; the strict executor rejects either relationship field without the other. Person names, projects, topics, and tags are not memory IDs.

## Known Limitations and Deferred Work

Progressive recall pagination beyond the initial bounded result is deferred.
