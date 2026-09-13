# @deepseek-ai/dsh-hivemind-memory

Owns the single `hivemind_meta` tool. It progressively selects company context, lexical entity lookup, bounded recall, governed save, or the exact HyperAgent directory while tenant scope remains server-derived. Entity lookup resolves a partial or ambiguous named subject before recall; the selected `canonical_name` becomes an exact `recall.entities` filter. Recall supports focused source, project, time, tag, media-kind, filename, and entity filters without accepting a tenant identifier.

## Model Experience

- **Visible tools:** one compact meta-tool.
- **Prompt cost:** one schema; evidence appears only after invocation.
- **KV-cache effect:** stable tool schema.

## Entity lookup

`entities` requires a partial or ambiguous `query` and accepts optional `entity_types`, `scope`, and `limit`. The provider derives tenant identity, and `scope` can only narrow the authorized inventory to `personal`, `project`, `team`, or `organization`. Omit entity lookup when the recall subject is already exact or when the request does not name a subject.

## Recall filters

`recall` always requires a focused `query`. Use `source_platforms`, `project`, time fields, `sort`, or `tags` only when the request supplies a relevant constraint. `media_kind`, `filename`, and `entities` are convenience inputs for internal media discovery; the tool converts them to the server's `kind:*`, `filename:*`, and `entity:*` tags. A recall result is evidence metadata, not a local filesystem path or a retrievable binary artifact.

## Known Limitations and Deferred Work

Progressive recall pagination beyond the initial bounded result is deferred.
