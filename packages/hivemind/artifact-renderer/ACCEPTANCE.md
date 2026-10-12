# HyperAgents generation acceptance — 2026-09-12

Scope: standalone HyperAgents on port 3094 through deepseek.singulancelabs.com, branch `hyperagents-playbooks-v1`. No Docker or other HIVE chat runner changes. Tests use internal drafts and prohibit publishing, payments, memory writes and employee child agents.

## Observed live

- Campaign draft pack: session `session-4e4e4846-173c-4826-ae21-1a3103e5ddf5` generated a one-page PDF, editable two-slide PPTX and XLSX. Three native browser downloads matched their stored SHA-256 hashes. Plan/todos completed without child agents. This is draft-generation acceptance, not compliance or campaign-launch approval.
- Finance initial canary: session `session-753af929-3c9e-46f1-a744-0ea07300836e` computed EUR 800.00 but missed the field method and invented approval requirements. **Failed content acceptance.** Its artifacts must not be treated as approved financial guidance.
- Finance retest: session `session-9f2bb08a-5efa-46c2-aceb-26a32f742936` returned `global-legal-finance` and `finance-legal-review`, loaded the field guidance, calculated EUR 800.00 and generated/downloaded the spreadsheet. Suggested controls were distinguished from company policy and thresholds remained unset. Seven tools, six steps, 34 seconds; this is hypothetical arithmetic/review acceptance, not accounting or legal certification.
- Product concept: session `session-fcc8f94b-ea37-4126-832f-1355c0685dc1` produced HTML and a generated PNG. Native preview authorization failed because the image was only in the business event, not the tool content. Fixed by emitting the normal image attachment in the tool result; a regression test covers that receipt. The original run remains a failed preview canary.
- Standalone image-provider request returned a real PNG through OpenRouter/Gemini and Cloudflare's configured BYOK alias. Image generation does not establish approved Brand DNA.
- Fresh image chat canary (`Generate one abstract navy and`, 19:41): native PNG preview displayed successfully and browser download matched stored SHA-256 `7197eef9aae7fdb466853b23d2693cb294264d715ba776ed24f31df14b77ccba`. Optional inspection still failed because its lookup used filtered model history. The vision tool now resolves native image references from durable session events, with three regression tests. The initial run's unnecessary recovery calls remain a failed inspection result, not a clean whole-turn acceptance.
- After the durable lookup fix, a 19:45 follow-up in that same session successfully used `inspect_image` on the existing image and reported no text/logos. It did not regenerate the image. The model still performed unnecessary recall and shell lookup; this is vision capability acceptance, not optimal execution acceptance. Inspection text receipts now also name the attachment and provider/model rather than returning an ambiguous bare answer.

## Changes prompted by live testing

- Use PptxGenJS's supported Node entry to avoid its ESM loader cycle.
- Keep finished artifact cards outside folded tool traces.
- Download binary artifacts through the session-authorized workspace byte Remote, not the text editor.
- Retain the best local method beside its global doctrine in compact discovery.
- Use one presentation-policy owner per turn even when context retrieval repeats.
- Preserve native image references for session-authorized previews.
- Make Composio's OAuth return route configurable for the standalone root UI.

## Not yet accepted

Higgsfield video authentication/integration; complete brand-specific generation/layout review; real connected publishing or sending and its measured outcome; all Company Room canaries; durable external-action deduplication; and compression-mode parity. Field recipes recommend stages and native workflows but are not independently certified publishing workflows. A configured provider or a passing unit test is not proof of authenticated delivery.

The authoritative system prefix and native Harness loop remain intact. Field-stage guidance uses a replaceable native snapshot; this work does not claim to eliminate cumulative conversation tokens.

Latest local verification: 111 tests in 11 files passed across generation, playbooks, connected applications, operating-run UI and durable vision lookup. Owning package TypeScript builds and whitespace checks passed.
