/** OpenRouter alpha Decisions / TypeSafe System One wire contract. */
import { z } from 'zod'
const name = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const description = z.string().min(1).max(8000)
const questionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions: description, criteria: z.object({ true: description.optional(), false: description.optional() }).strict().optional() }).strict(),
  z.object({ type: z.literal('choice'), instructions: description, criteria: z.record(name, description).refine(value => Object.keys(value).length >= 2 && Object.keys(value).length <= 32) }).strict(),
  z.object({ type: z.literal('score'), instructions: description, criteria: z.array(description).min(2).max(10) }).strict(),
])
export const evaluationSchema = z.object({
  state: z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]),
  questions: z.record(name, questionSchema).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 32),
}).strict()
export type EvaluationRequest = z.infer<typeof evaluationSchema>
export type DecisionQuestion = EvaluationRequest['questions'][string]
const probability = z.number().finite().min(0).max(1)
const distribution = z.record(z.string(), probability)
const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities: distribution, confidence: probability }),
  z.object({ type: z.literal('score'), score: z.number().finite(), probabilities: distribution, confidence: probability, legend: z.record(z.string(), z.unknown()).optional() }),
])
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional(),
  }).optional(),
})
export type EvaluationResponse = z.infer<typeof responseSchema>
/** Validate exact answer keys, matching primitives and candidate distributions. */
export function validateAnswers(raw: unknown, request: EvaluationRequest): EvaluationResponse {
  const response = responseSchema.parse(raw)
  if (Object.keys(response.answers).length !== Object.keys(request.questions).length) throw new Error('decision answer count mismatch')
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers[id]
    if (!answer || answer.type !== question.type) throw new Error('decision answer type mismatch')
    if (answer.type === 'noul') continue
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.type === 'score' ? question.criteria.map((_, i) => String(i)) : []
    if (Object.keys(answer.probabilities).length !== keys.length || keys.some(key => answer.probabilities[key] === undefined)) throw new Error('decision distribution keys mismatch')
    const sum = Object.values(answer.probabilities).reduce((total, value) => total + value, 0)
    if (Math.abs(sum - 1) > 0.001) throw new Error('decision distribution must sum to one')
    if (answer.type === 'choice') {
      if (!keys.includes(answer.choice)) throw new Error('decision selected unknown choice')
      const maximum = Math.max(...Object.values(answer.probabilities))
      if ((answer.probabilities[answer.choice] ?? 0) + 0.000001 < maximum) throw new Error('decision winner is not highest probability')
    } else {
      const expected = keys.reduce((total, key) => total + Number(key) * (answer.probabilities[key] ?? 0), 0)
      if (Math.abs(answer.score - expected) > 0.01) throw new Error('decision score does not match distribution')
    }
  }
  return response
}
