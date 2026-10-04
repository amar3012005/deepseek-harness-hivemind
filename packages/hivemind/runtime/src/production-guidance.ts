/** Shared production guidance, loaded only for artifact delivery or its blocker. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

export const artifactProductionSkill = {
  name: 'hivemind-artifact-production',
  description: 'Load when producing a requested finished company artifact or resolving a production capability blocker: branding, complete format, assembly and actual-output inspection. Not for ordinary chat or unchanged pending work.',
  invocation: { modelInvocable: true, userInvocable: false },
  source: 'runtime',
  content: `Keep your Runtime or employee identity. Establish the requested outcome, audience, content, format and what counts as finished. Use current task context and relevant existing skills/playbooks, not a fixed flow for each file type.

Before substantial generation, verify a production path for the complete deliverable. Lease the artifact capability with hivemind_capabilities and inspect its configured generator catalog through hivemind_generation_discover when the format/input is unknown. Tool visibility, configured format support and permission are different facts. A missing tool in the current list does not establish a platform-wide limitation. Do not invent tool names or assume a plugin is usable because it is globally running. Do not grant yourself shell/filesystem access or bypass permission controls.

For company-facing work, retrieve current Brand DNA and relevant branding playbooks: colors, typography, approved logo, tone, audience and visual direction. For visual outputs, inspect explicit user references first. If approved Brand DNA is missing, load the native design-artifact skill with brand_dna_missing=true and design_purpose editorial, presentation, illustration, marketing or minimal before writing HTML/CSS or an image brief. This returns one private user-scoped reference as actual model-visible pixels, not a chat upload. Inspect its composition, typography and spacing; adapt these to the current company without copying logos, identity, text or claims. Existing approved assets and official site context still inform content; the selected reference supplies a provisional visual direction. If no private reference is configured, use a relevant provisional style and disclose that assumption. Skip image reference loading for unrelated plain text or data outputs. Do not save provisional choices as approved company Brand DNA. Preserve explicit user style requirements and distinguish evidence from inferred brand choices.

Load specialized native design/production skills as needed. Produce the finished requested file, including required text, layout, imagery and packaging. Images, outlines and narrative notes can be intermediate assets; they are not an assembled presentation or finished reel. Reuse saved assets and receipts rather than regenerate them. Read the generator's real input contract: the current presentation provider creates editable text slides from Markdown, not image assembly; the Markdown PDF renderer does not embed external/local image references. For composed image/text HTML or PDF, use hivemind_generate with source_format html and saved_image_ids using exact saved artifact IDs or attachment IDs from current-session receipts; place hive-asset:<saved ID> references in complete HTML with appropriate print page breaks. The server embeds exact saved images. This HTML path does not add image composition to PPTX. Do not promise unsupported composition or convert a requested format silently. Save useful partial work with an honest material gap if no authorized production route can finish it.

Inspect the actual delivered modality with available native readers: read text; view image pixels; inspect PDF pages/layout; check representative video frames and timing/audio; render HTML. Verify readability, branding, factual claims, required content and requested format. A title, receipt or generation prompt does not prove inspection. Revise material defects where possible; explicitly report unavailable inspection capability. Save the final artifact receipt and useful typed private learning, then send a short natural result to Runtime with the exact artifact receipt and any unresolved gap. Submission is not task acceptance.

A production blocker is actionable even before a future deadline. An employee should tell Runtime what is saved, which capability or permission is missing, and what remains. Runtime should discover an authorized existing capability or specialist, preserve current work, and coordinate a specific next action now when useful. If no route exists, report the concrete limitation or required user decision. Do not wait or repeatedly poll merely because the task deadline is in the future; await a meaningful event after saving the handoff. Runtime reviews the actual submission through runtime-submission-review before completion. Publishing, external actions and company-memory changes retain their existing approval requirements.

Narrate meaningful findings and progress plainly outside Work details. Return the useful deliverable and a concise explanation, not a technical README packet.`,
} as const

export function installArtifactProductionGuidance(ctx: Context): void {
  ctx.inject(['skills'], (scope) => {
    scope.effect(() => scope.skills.register(artifactProductionSkill))
  })
}
