/** Shared production guidance, loaded only for artifact delivery or its blocker. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

export const artifactProductionSkill = {
  name: 'hivemind-artifact-production',
  description: 'Load when producing a requested finished company artifact or resolving a production capability blocker: branding, complete format, assembly and actual-output inspection. Not for ordinary chat or unchanged pending work.',
  invocation: { modelInvocable: true, userInvocable: false },
  source: 'runtime',
  content: `Keep your Runtime or employee identity. Establish the requested outcome, audience, content, format and what counts as finished. Use current task context and relevant existing skills/playbooks, not a fixed flow for each file type.

For any already saved supported artifact (HTML/Markdown/plain text, image or PDF), use hivemind_artifact_inspect with its exact durable artifact ID to read the exact saved source or inspect available actual pixels. An accepted employee transfer authorizes that saved file in this room; no team-task prerequisite is required. Do not claim the artifact is unreadable before attempting this reader. If the receipt is missing, ask the producer to share the saved artifact through native messaging; company membership alone is not an access grant. Reading HTML source verifies content, not rendered visual layout. A restart or empty job_list does not mean the image is missing; reuse the persisted reader rather than regenerate it. Lease the artifact lane if the reader is not exposed.

Before substantial generation, verify a production path for the complete deliverable. Lease the artifact capability with hivemind_capabilities and inspect its configured generator catalog through hivemind_generation_discover when the format/input is unknown. When a saved artifact is required and generation tools are absent from the current surface, call hivemind_capabilities with operation lease and capabilities [artifact], then inspect the newly exposed exact tool schemas. Use operation list first only if the lane itself is unknown. Loading this production skill supplies instructions, not the capability lease. Do not report that an artifact route is unavailable merely because you have not leased it; claim a missing route only after the actual native capability/discovery result establishes the gap. A failed PDF renderer is a concrete execution failure to recover or report with its receipt, not evidence that every artifact tool is absent. Do not force artifact production for casual replies. Tool visibility, configured format support and permission are different facts. A missing tool in the current list does not establish a platform-wide limitation. Do not invent tool names or assume a plugin is usable because it is globally running. Do not grant yourself shell/filesystem access or bypass permission controls.

For company-facing work, retrieve current Brand DNA and relevant branding playbooks: colors, typography, approved logo, tone, audience and visual direction. For visual outputs, inspect explicit user references first. If approved Brand DNA is missing, load design-artifact through the native skill tool before writing HTML/CSS or an image brief. Its successful result includes the private saved visual exemplar. The custom hivemind_skills loader may alternatively select design_purpose editorial, presentation, illustration, marketing or minimal with brand_dna_missing=true. A recalled official homepage does not establish approved Brand DNA and must not suppress the saved private reference. This returns one private user-scoped reference as actual model-visible pixels, not a chat upload. Inspect its composition, typography and spacing; adapt these to the current company without copying logos, identity, text or claims. Existing approved assets and official site context still inform content; the selected reference supplies a provisional visual direction. If no private reference is configured, use a relevant provisional style and disclose that assumption. Skip image reference loading for unrelated plain text or data outputs. Do not save provisional choices as approved company Brand DNA. Preserve explicit user style requirements and distinguish evidence from inferred brand choices.

For every HTML-producing turn, including a later correction, load design-artifact again through the native skill tool before authoring. A skill loaded in a previous turn does not mean the current model request has reference pixels or the saved HTML source. The native result provides the latest same-chat HTML source and its saved preview when available, plus the private fallback image; read and inspect that material before writing. When revising a saved artifact, preserve the established composition, typography, illustration and complete content, making only the requested changes unless the user asked for a redesign. Do not replace a designed document with a plain placeholder, outline, stripped-down template or promise of future rendering. If the wrong latest artifact is a placeholder, inspect the earlier accepted designed artifact through the native saved-artifact reader and restore its design. Only present a replacement as finished after rendering and checking its actual pixels. Load specialized native design/production skills as needed. Produce the finished requested file, including required text, layout, imagery and packaging. Images, outlines and narrative notes can be intermediate assets; they are not an assembled presentation or finished reel. Reuse saved assets and receipts rather than regenerate them. Read the generator's real input contract: the current presentation provider creates editable text slides from Markdown, not image assembly; the Markdown PDF renderer does not embed external/local image references. For composed image/text HTML or PDF, use hivemind_generate with source_format html and saved_image_ids using exact saved artifact IDs, browser capture IDs or screenshot attachment IDs from current-session receipts; place hive-asset:<saved ID> references in complete HTML with appropriate print page breaks. The server embeds exact saved images, including native browser screenshots; reference_artifact_ids on image generation accepts these same saved capture or screenshot attachment IDs as actual reference pixels. When a recalled web record points to an internal storage URL that returns not found, use its authoritative public source URL with the native browser or source reader; do not invent paths or abandon a readable official source because its older internal preview is unavailable. This HTML path does not add image composition to PPTX. Do not promise unsupported composition or convert a requested format silently. Save useful partial work with an honest material gap if no authorized production route can finish it.

Inspect the actual delivered modality with available native readers: read text; view image pixels; inspect PDF pages/layout; check representative video frames and timing/audio; render HTML. Verify readability, branding, factual claims, required content and requested format. A title, receipt or generation prompt does not prove inspection. Revise material defects where possible; explicitly report unavailable inspection capability. Save the final artifact receipt and useful typed private learning, then send a short natural result to Runtime with the exact artifact receipt and any unresolved gap. Submission is not task acceptance.

A production blocker is actionable even before a future deadline. An employee should tell Runtime what is saved, which capability or permission is missing, and what remains. Runtime should discover an authorized existing capability or specialist, preserve current work, and coordinate a specific next action now when useful. If no route exists, report the concrete limitation or required user decision. Do not wait or repeatedly poll merely because the task deadline is in the future; await a meaningful event after saving the handoff. Runtime reviews the actual submission through runtime-submission-review before completion. Publishing, external actions and company-memory changes retain their existing approval requirements.

Narrate meaningful findings and progress plainly outside Work details. Return the useful deliverable and a concise explanation, not a technical README packet.`,
} as const

export const imageGenerationSkill = {
  name: 'hivemind-image-generation',
  description: 'Load for image generation or editing: prepare a grounded visual brief, use approved branding and actual references, inspect saved pixels, and recover confirmed no-output failures through the native media tool. Not for image analysis or video.',
  invocation: { modelInvocable: true, userInvocable: false }, source: 'runtime',
  content: `# Image generation

Prepare one grounded, art-directed brief, then use the native \`hivemind_media_generate\` tool. The server selects the image provider; do not choose a model, expose provider credentials, or introduce a second generation workflow.

## Gather only the context that changes the image

- Preserve the user's requested subject, format, language, exact copy and visual direction. Resolve references such as “another version” from the current conversation and completed artifact receipts.
- For company, product, customer or campaign imagery, use relevant context already available. If brand identity, audience, positioning or current product facts are missing, make one focused \`hivemind_meta\` recall using the actual company and task. Request only recall arguments from its current schema; do not fill unrelated operations or optional fields with empty strings.
- When \`hyperagents_memory\` is available, recall relevant prior visual corrections, preferences or production learnings not already in context. Keep private agent memory separate from shared company facts. Avoid duplicate recall on every variation.
- In modes exposing \`hivemind_playbooks\`, reuse selected guidance or retrieve the applicable global creative/branding method and a matching local visual playbook. Search actual candidates; never invent a playbook ID. Load only guidance relevant to this artifact. An absent local playbook is a gap, not a reason to manufacture one or stop useful work.
- In ordinary chat without playbook tools, use company recall, conversation and this skill. Do not start task planning, directory discovery or employee delegation merely to generate an image.
- General imagery unrelated to company work needs no company retrieval. Missing nonessential context can remain unspecified. Ask one concise question only when a missing detail materially prevents a useful result; the user's generation request already authorizes producing the requested draft.

## Build the complete creative brief

Give the image provider visual instructions, not a request to research the company. Include:

- Purpose, audience and destination: campaign poster, website hero, product illustration, social post or personal concept.
- Subject and visual idea: a specific focal motif, supporting elements and what the scene should communicate.
- Composition: hierarchy, framing, subject placement, negative space and safe areas for profile overlays or later text placement.
- Art direction: medium, shape language, lighting, texture, contrast and a coherent palette. Use verified brand colors and typography where known. A new creative direction is a proposal, not an established brand rule.
- Exact readable text, spelling, language and hierarchy, or explicitly no text. Do not invent slogans, product capabilities, customers, certifications or performance claims.
- Requested aspect ratio and any supplied dimensions. Use the tool's actual supported arguments; put layout intent in the brief when there is no dimension field. Do not claim exact exported dimensions unless the artifact verifies them.
- References and edit scope: what must remain recognizable, what changes, and what must stay untouched. For edits, use session-owned uploaded images or authorized artifact IDs. Use public reference URLs only when actually supplied or verified. Never invent IDs, fetch private files through a public URL, or include credentials or unnecessary private correspondence in the brief.
- Focused exclusions for known pitfalls: clutter, generic stock imagery, inaccurate copy, distorted logo, misplaced focal point, unwanted text. Avoid long contradictory style lists.

For an existing logo or brand asset, use the authorized reference rather than describing an imagined replacement. If exact typography or logo fidelity is essential, inspect the result and report limitations instead of claiming pixel-perfect compliance.

## Generate, inspect and deliver

1. Load this skill once for the current image task, prepare the brief from the relevant evidence, and call \`hivemind_media_generate\` with \`kind: image\`, a useful title and that brief. Use the actual registered schema. Provider selection remains server-owned.
2. Reuse the same operation identity and unchanged inputs for recovery. Track the returned job with native job tools only when needed; do not resubmit while it runs. An unknown outcome requires reconciliation, not a fresh operation ID. A deliberate new variation is a new operation.
3. Keep the native progress and artifact presentation in use. Completion requires a confirmed artifact receipt; a running job, assistant claim or empty output is not an image.
4. Inspect actual saved pixels with hivemind_artifact_inspect after leasing artifact when needed; a saved receipt or browser URL alone is not inspection. Check readable text, factual accuracy, composition, brand references and destination safe areas. If inspection is unavailable, say so only when it affects confidence; do not claim a visual review occurred.
5. Correct a material defect with a focused edit when authorized. Avoid unrequested generation loops or charging for extra variants. Deliver the existing artifact/preview with a short description of the actual result and any material limitation. Do not generate again simply to obtain another display link.

Saving to company memory, publishing or sending the image is a separate action governed by its existing permissions. Record a private reusable correction only when supported by an actual result and the relevant memory tool is available.

For a confirmed primary no-output failure, the native media result may supply an operation_id and configured Muse fallback recovery. Reuse the exact creative brief, reference_artifact_ids or latest uploaded images and supported aspect ratio; call the same native media tool with fallback_from_operation set to that failed operation ID. The server validates the failed parent and creates a distinct operation with the same authorized pixels. If Muse is unavailable or the request is unsupported, report that concrete gap. Unknown outcomes, pending work, policy rejections and unconfirmed outputs must never switch providers: reconcile the original operation with unchanged inputs and its original provider. Do not mint a new operation to hide an unknown outcome.
`,
} as const

export function installArtifactProductionGuidance(ctx: Context): void {
  ctx.inject(['skills'], (scope) => {
    scope.effect(() => {
      const removeProduction = scope.skills.register(artifactProductionSkill)
      const removeImage = scope.skills.register(imageGenerationSkill)
      return () => { removeImage(); removeProduction() }
    })
  })
}
