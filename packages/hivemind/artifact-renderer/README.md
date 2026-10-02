# HIVE-MIND artifact renderer

## HIVE design profiles

The renderer owns five visual baselines: `executive`, `editorial`, `campaign`,
`product`, and `data`. The PDF tool selects one through `design_profile`, maps it
to the Markdown PDF package's native typography and link colors, and records it
in the durable receipt. HTML artifact previews keep their separate browser
rendering path.

`design_quality` reports deterministic Markdown structure checks. It is not a
claim of visual judgment. A vision provider remains progressive and optional
when a real visual review is necessary.

The generation registry exposes document discovery and foreground PDF, PPTX, XLSX, and HTML generation through the artifact lane. Image and video use `hivemind_media_generate`: one compact start call admits an owner-scoped native background job, records its start, validates and stores its result, records a terminal receipt, and lets the native job controller deliver completion or cancellation. Generated files are stored as attachments before `hivemind/generation-created` is appended; generation does not publish, send, approve, or certify the content. Provider registration is disposable.

## Model Experience

Generation uses one small content or creative-brief input and no additional planning model. Only the leased artifact lane exposes its tools. Receipts contain file references instead of file contents; source text remains in the native tool-call history. The model chooses whether media belongs in its plan, while the media workflow—not another model step—owns validation, execution, bounded image retry, cancellation, attachment storage, and terminal reporting.

## Known Limitations and Deferred Work

Generated images and HTML artifacts are persisted with native PNG previews as well as downloadable files. HTML previews are screenshots of the actual self-contained document in a sandboxed, network-blocked Playwright page; the generated HTML remains editable and is not deployed. The UI downloads binary artifacts through the existing session-authorized workspace byte Remote and checks file versions across pages. Gateway-backed image routes can set `imageGatewayByokAlias` to the deployment's configured credential alias; no provider secrets enter tool inputs.

Office layouts use deterministic typography and editable text. An optional OpenRouter-compatible image provider uses deployment-owned credentials and a configurable model, independently of the session model. The image workflow retries only explicit rate-limit responses; ambiguous transport failures are not retried because doing so can create duplicate billable generations. The optional Higgsfield video provider executes its CLI without a shell, checks authentication before job admission, accepts a prior session image artifact as a start frame, bounds duration and file size, validates the downloaded MP4 header, and returns an actionable authentication gate instead of starting doomed work. Content and visual review remain separate from successful byte generation.

The local native job registry survives model turns and browser disconnects but not a host-process restart. Full restart-safe video resumption requires an external workflow provider that persists the Higgsfield provider job identifier; the provider-neutral generation registry allows that replacement without changing the model-facing tool.

PDF rendering converts Markdown directly with PDFKit and does not launch a browser. Model-authored image references are omitted; the PDF renderer does not read local files or fetch network images. The first-page PNG preview is rasterized from the actual PDF, not a screenshot of a separate representation. `hivemind_calculate` provides exact two-decimal sums and running balances; it does not verify source figures or perform legal review.

PPTX and XLSX are durable, editable downloads today. Their specialized slide and table preview renderers are deferred rather than showing an inaccurate synthetic image. Video completion currently projects workflow state and a downloadable file; a native player/poster renderer remains deferred.

`@deepseek-ai/dsh-hivemind-artifact-renderer` adds the progressively disclosed `hivemind_artifact_render` tool without changing the agent loop. The consumer targets the `hivemindArtifactRenderer` service, whose Markdown PDF provider uses `@speajus/markdown-to-pdf` and PDFKit. A successful call writes a unique workspace PDF, commits PDF and PNG preview attachments, then appends `hivemind/artifact-created`; the native Web projection can replay the thumbnail, show the full PDF in Preview, and open or download the produced file. The provider owns the requested A4 or Letter scale and returns authoritative `page_count`, `pdf_bytes`, and `layout_status` fields, so the agent does not need a second shell call to validate ordinary output.

The document-design and Brand DNA skills remain separate. A PDF request loads document guidance; brand guidance is loaded only when the user, audience, or selected playbook makes organizational styling relevant.

README and other Markdown documents use the same lane: the native file tool reads the requested source, the progressively loaded document-design skill adapts its hierarchy and content, and this renderer converts the finished Markdown to PDF and preview. Branding and evidence handling remain model-selected; the renderer owns pagination and print typography.

## Native Codex images

Both HIVEMIND presets select `imageProvider: codex` on the shared renderer. The native app-server image tool uses the existing protected Codex OAuth store through a host-only credential resolver. It does not use the plan-sharing Responses endpoint or silently fall back to separately billed API generation. Server configuration controls the executable, model, private state directory, and timeout.

`hivemind_media_generate` accepts a complete brief, optional transparency, and up to five session-owned image references for edits. Stable operation IDs persist intent before dispatch and reuse completed receipts. Interrupted operations reconcile the recorded Codex thread; unknown outcomes stop without regeneration. Exact output bytes and PNG previews are stored as authorized attachments. The local background job itself does not survive a runner restart; recovery requires the same operation inputs with `resume_operation: true`. Account entitlement and provider availability remain external requirements.
