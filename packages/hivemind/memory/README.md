# @deepseek-ai/dsh-hivemind-memory

Owns compact `hivemind_meta` read routing plus direct `hivemind_save_memory` writes. The meta-tool progressively selects company context, bounded recall, or the exact HyperAgent directory; the direct writer exposes its exact save schema on the first model call. Tenant scope remains server-derived for both.

## Model Experience

- **Visible tools:** one compact read meta-tool and one direct governed writer.
- **Prompt cost:** two small stable schemas; evidence appears only after invocation.
- **KV-cache effect:** stable tool schema.

## Recall filters

`recall` always requires a focused `query`. Use `source_platforms`, `project`, time fields, `sort`, or `tags` only when the request supplies a relevant constraint. `media_kind`, `filename`, and `entities` are convenience inputs for internal media discovery; the tool converts them to the server's `kind:*`, `filename:*`, and `entity:*` tags. A recall result is evidence metadata, not a local filesystem path or a retrievable binary artifact.

## Known Limitations and Deferred Work

Progressive recall pagination beyond the initial bounded result is deferred.
