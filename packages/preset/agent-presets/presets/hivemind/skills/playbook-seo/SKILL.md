---
name: playbook-seo
description: Load when the user asks to audit a website's SEO or technical search visibility and report concrete issues found on that site. Maps to seo.audit.v1. Requires seo_evidence; prose alone never completes it.
---

# SEO playbook

Profile: `seo.audit.v1`. Room kind: `seo`. Effect: `prepare_only`. Required artifact: `seo_evidence`.

Issues found on a named site. Keyword strategy with no crawl is `playbook-marketing`. Competitive landscape is `playbook-research`.

## Sequence

1. Load `output-contract` if it is not already in context. Load `research-web` before fetching the site.
2. Fetch only the URLs in scope after native web approval. Record every fetched URL in `seo_evidence`. Do not invent rankings, index status, or backlink counts.
3. Write `seo_evidence` in the workspace: URL, finding, evidence snippet or status code, and severity. Recommendations that are not backed by a fetched page stay in a gaps section.
4. Company brand terms come from `hivemind_meta`, not from guessed positioning.
5. Do not publish meta tags or make live site edits from this profile unless the user opened a connected or workspace coding task for that change.

## Completeness

The turn is incomplete until `seo_evidence` exists as a workspace file. A denied or failed fetch still returns a labeled unverified draft naming the URLs not retrieved.
