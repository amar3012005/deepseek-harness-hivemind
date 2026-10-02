# Session attachment preview

English | [中文](2026-10-02-attachment-artifact-preview.zh.md)

Artifacts use a compact horizontal file row and exact session-authorized attachment preview in native Sidebar navigation. The completed media workflow card is hidden when the saved artifact replaces it. Image and video previews use browser media elements; PDF and HTML use an isolated frame; text and Markdown display source. Other files retain downloads.

Attachments remain durable and session scoped. The preview uses attachment receipts rather than exposing provider paths or assuming a workspace file. Object URLs are revoked on disposal and stale reads are ignored.
