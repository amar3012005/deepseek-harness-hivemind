import { expect, it, vi } from 'vitest'
import { jevReview, runtimeReviewDecision, runtimeReviewAccepts, reviewAnswers, savedArtifactText, savedArtifactAttachment, savedSourceEvidence } from '../src/review.ts'
it('fails closed on missing answers and uncertainty rather than certifying prose', () => {
  expect(reviewAnswers({ model: 'jev', answers: { criterion_0: { type: 'noul', noul: 0.99 }, criterion_1: { type: 'noul', noul: 0.7 } } }, 2).status).toBe('uncertain')
  expect(reviewAnswers({ model: 'jev', answers: { criterion_0: { type: 'noul', noul: 0.99 } } }, 1).status).toBe('accepted')
  expect(() => reviewAnswers({ model: 'jev', answers: {} }, 1)).toThrow('hq_review_invalid_response')
})
it('uses only the source input of a matched successful artifact receipt', () => {
  const events = [
    { type: 'tool/call', data: { callId: 'one', name: 'hivemind_artifact_render', arguments: JSON.stringify({ markdown: '# Saved document' }) } },
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'one', content: [{ type: 'text', text: JSON.stringify({ artifact_id: 'saved-1' }) }] }] } } },
  ]
  expect(savedArtifactText(events, 'saved-1')).toBe('# Saved document')
  expect(savedArtifactText(events, 'invented')).toBeUndefined()
  expect(savedArtifactText([events[0]!, { type: 'tool/result', data: { meta: { artifact_id: 'saved-pdf' }, message: { content: [{ type: 'tool-result', toolCallId: 'one', content: [{ type: 'text', text: 'Rendered PDF receipt.' }] }] } } }], 'saved-pdf')).toBe('# Saved document')
  expect(savedArtifactText([events[0]!, { ...events[1]!, data: { message: { content: [{ type: 'tool-result', toolCallId: 'one', isError: true, content: [{ type: 'text', text: JSON.stringify({ artifact_id: 'saved-1' }) }] }] } } }], 'saved-1')).toBeUndefined()
})
it('carries exact passages from a matching fetched source rather than invented citations', () => {
  const url = 'https://example.com/imprint'
  const events = [{ type: 'tool/call', data: { callId: 'read', name: 'browser_markdown' } }, { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'read', content: [{ type: 'text', text: JSON.stringify({ url, markdown: 'Our headquarters are in Hannover.' }) }] }] } } }]
  expect(savedSourceEvidence(events, `Source ${url}: “Our headquarters are in Hannover.”`)[0]?.exactPassages).toEqual(['Our headquarters are in Hannover.'])
  expect(savedSourceEvidence(events, `Source ${url}: “Our headquarters are in Berlin.”`)[0]?.exactPassages).toEqual([])
})

it('decodes the observed Workers AI REST wrapper without mistaking HTTP success for acceptance', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32)); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token')
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, result: { state: 'test', result: { model: 'jev-1.13.0', answers: { criterion_0: { type: 'noul', noul: 0.98 } } } } })))
  try { expect((await jevReview({ document: 'Decision: inspect public sources.' }, ['An explicit decision'], new AbortController().signal)).status).toBe('accepted') }
  finally { request.mockRestore(); vi.unstubAllEnvs() }
})

it('uses the dedicated Jev Decisions credential and preserves typed acceptance checks', async () => {
  vi.stubEnv('JEV_OPENROUTER_API_KEY', 'test-jev-key')
  vi.stubEnv('JEV_MODEL', '~typesafe/jev-latest')
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    model: 'jev-1.13.0', answers: { criterion_0: { type: 'noul', noul: 0.98 } },
  })))
  try {
    expect((await jevReview({ document: 'Saved evidence' }, ['Evidence exists'], new AbortController().signal)).status).toBe('accepted')
    expect(request.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/alpha/decisions')
    const options = request.mock.calls[0]?.[1]
    expect(JSON.parse(String(options?.body))).toMatchObject({ model: '~typesafe/jev-latest', state: { document: 'Saved evidence' } })
    expect(JSON.parse(String(options?.body))).not.toHaveProperty('input')
  } finally { request.mockRestore(); vi.unstubAllEnvs() }
})

it('requires Runtime’s explicit current evidence decision; Jev is advisory only', () => {
  const current = { revision: 2, inputHash: 'saved-hash' }
  const input = { decision: 'accepted', rationale: 'Inspected the saved brief and exact learning/return receipts.', task_revision: 2, evidence_hash: 'saved-hash' }
  const decision = runtimeReviewDecision(input, current)
  const review = { ...decision, taskId: 'task-1', taskRevision: 2, inputHash: 'saved-hash', artifactIds: ['artifact'] }
  expect(runtimeReviewAccepts(review, 2, ['artifact'])).toBe(true)
  expect(runtimeReviewAccepts({ ...review, reviewer: 'jev', probabilities: [1] }, 2, ['artifact'])).toBe(false)
  const legacyReview = {
    taskId: review.taskId,
    taskRevision: review.taskRevision,
    inputHash: review.inputHash,
    artifactIds: review.artifactIds,
    status: review.status,
    model: review.model,
    probabilities: review.probabilities,
  }
  expect(runtimeReviewAccepts(legacyReview, 2, ['artifact'])).toBe(false)
  expect(runtimeReviewAccepts(review, 3, ['artifact'])).toBe(false)
  expect(runtimeReviewAccepts(review, 2, ['other'])).toBe(false)
  expect(() => runtimeReviewDecision({ ...input, task_revision: 1 }, current)).toThrow('hq_review_task_changed')
  expect(() => runtimeReviewDecision({ ...input, evidence_hash: 'old' }, current)).toThrow('hq_review_evidence_changed')
  expect(() => runtimeReviewDecision({ ...input, rationale: '' }, current)).toThrow('hq_runtime_review_decision_required')
  const changes = runtimeReviewDecision({ ...input, decision: 'needs_changes', rationale: 'Missing required seasonal ingredient.' }, current)
  expect(runtimeReviewAccepts({ ...review, ...changes }, 2, ['artifact'])).toBe(false)
})

it('exposes committed binary modality without claiming unseen content or accepting invented refs', () => {
  const file = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'visual.bin', bytes: 705 }
  for (const [mediaType, modality] of [['image/png', 'image'], ['video/mp4', 'video'], ['application/pdf', 'pdf']]) {
    expect(savedArtifactAttachment([{ type: 'hivemind/generation-created', data: { artifactId: 'saved', file, mediaType } }], 'saved')).toMatchObject({ file, mediaType, modality })
  }
  expect(savedArtifactAttachment([{ type: 'tool/result', data: { artifactId: 'saved', file } }], 'saved')).toBeUndefined()
  expect(savedArtifactAttachment([{ type: 'hivemind/generation-created', data: { artifactId: 'other', file } }], 'saved')).toBeUndefined()
  expect(savedArtifactAttachment([{ type: 'hivemind/generation-created', data: { artifactId: 'saved', file: { ...file, attachmentId: 'invented' } } }], 'saved')).toBeUndefined()
})
