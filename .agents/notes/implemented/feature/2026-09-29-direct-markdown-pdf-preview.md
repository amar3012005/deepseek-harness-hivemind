# Agent Note: HyperAgents renders Markdown PDFs without a browser

Status: implemented

English | [中文](2026-09-29-direct-markdown-pdf-preview.zh.md)

## Problem

The production runner's PDF tool depended on Playwright Chromium, which was not present in the deployed runtime image. The Preview tab showed only the first-page PNG, so users could not read a multipage report in the pane.

## Decision

`hivemind_artifact_render` accepts Markdown and uses `@speajus/markdown-to-pdf` with PDFKit to create the document directly. Its PDFKit dependency is pinned to the npm release `0.17.2`; the renderer disables emoji fonts and blocks image reads and fetches. PDF.js rasterizes page one for the durable thumbnail, and the event retains the PDF and preview attachment references.

The HyperAgents Preview tab retrieves the PDF through the session-authorized attachment Remote and embeds it in a scrollable browser PDF frame. It exposes a Download PDF action. Other HTML and office artifact paths retain their existing renderers.

Generated PDF cards in the conversation also expose **Open in Preview**, which opens that session's Preview tab; the PDF itself is resolved from the session's latest artifact.

## Alternatives considered

**Render Markdown as HTML and print with Playwright.** Rejected because the deployed runner did not include a browser runtime and the PDF can be generated from Markdown without starting one.

**Install the Markdown package's GitHub PDFKit fork and postinstall.** Rejected because the repository blocks exotic transitive dependencies. The npm PDFKit release supports the report features used here; color emoji is disabled, so the fork's patch is unnecessary.

**Preview only the first-page image.** Rejected because it does not let users inspect the complete report in the Preview pane.

## Consequences

PDF text, headings, lists, tables, and links are paginated by PDFKit, with typography selected by the HIVE design profile. Markdown image references become placeholders; the renderer does not read local paths or fetch URLs. The iframe uses the browser's native PDF viewer, while the existing PNG remains the fast transcript thumbnail.
