/** Progressive model access to the complete scoped Harness skill registry. @module @deepseek-ai/dsh-hivemind-progressive-skills */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import { THINK_SKILLS } from './think-skills.ts'

export const name = 'hivemind-progressive-skills'
export const inject = ['tools', 'skills']

/** Deployment-owned progressive discovery limits. */
export interface Config { maxSearchResults: number; maxQueryChars: number }

export const Config: z<Config> = z.object({
  maxSearchResults: z.natural().min(1).max(20).default(6),
  maxQueryChars: z.natural().min(1).default(4_000),
})

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('hivemind-progressive-skills: arguments must be an object')
  return value as Record<string, JsonValue>
}

function text(value: JsonValue | undefined, label: string, maxChars: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`hivemind-progressive-skills: ${label} must be a non-empty string`)
  const result = value.trim()
  if (result.length > maxChars) throw new TypeError(`hivemind-progressive-skills: ${label} exceeds ${maxChars} characters`)
  return result
}

function terms(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 2))
}

function relevance(query: Set<string>, value: string): number {
  const candidate = terms(value)
  let score = 0
  for (const term of query) if (candidate.has(term)) score += 1
  return score
}

function activeAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new TypeError('hivemind-progressive-skills: active agent required')
  return agent
}

const output = {
  schema: { type: 'object' as const, additionalProperties: true, properties: {} },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Register compact search and exact loading over all model-invocable scoped skills. */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const maxSearchResults = config.maxSearchResults ?? 6
  const maxQueryChars = config.maxQueryChars ?? 4_000
  ctx.tools.register(defineTool({
    name: 'hivemind_skills',
    description: 'Search the complete HyperAgents skill library without loading its catalog into every request, then load the exact specialized instructions only when they materially improve the task. Use search with the full capability or artifact need, inspect compact candidates, and load only selected names. Do not use for direct answers or when native tools already make the work clear.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['search', 'load'] },
      query: { type: 'string', description: 'Complete specialized capability, method, or output need.' },
      name: { type: 'string', description: 'Exact skill name returned by search.' },
      limit: { type: 'integer', description: 'Maximum compact search candidates.' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      const input = record(args as JsonValue)
      const operation = text(input.operation, 'operation', 20)
      const agent = activeAgent(execution.agent)
      const options = { cwd: agent.session.header.cwd, signal: execution.signal, scope: agent }
      if (operation === 'search') {
        const queryText = text(input.query, 'query', maxQueryChars)
        const requestedLimit = input.limit ?? maxSearchResults
        if (!Number.isInteger(requestedLimit) || (requestedLimit as number) < 1 || (requestedLimit as number) > maxSearchResults) throw new TypeError(`hivemind-progressive-skills: limit must be from 1 to ${maxSearchResults}`)
        const snapshot = await ctx.skills.snapshot(options)
        if (!snapshot.complete) return { status: 'unavailable', operation: 'search', reason: 'skill discovery is incomplete; retry once' }
        const query = terms(queryText)
        const nativeSkills = snapshot.skills.filter(isModelInvocable)
        const candidates = [...nativeSkills, ...THINK_SKILLS.filter(skill => !nativeSkills.some(native => native.name === skill.name))]
          .map(skill => ({ skill, relevance: relevance(query, `${skill.name} ${skill.description} ${'whenToUse' in skill ? skill.whenToUse ?? '' : ''}`) }))
          .filter(candidate => candidate.relevance > 0)
          .sort((left, right) => right.relevance - left.relevance || left.skill.name.localeCompare(right.skill.name))
          .slice(0, requestedLimit as number)
          .map(({ skill, relevance: score }) => ({ name: skill.name, description: skill.description, relevance: score }))
        return { status: 'ready', operation: 'search', candidates }
      }
      if (operation !== 'load') throw new TypeError('hivemind-progressive-skills: unsupported operation')
      const skillName = text(input.name, 'name', 200)
      const nativeSkill = await ctx.skills.get(skillName, options)
      const skill = nativeSkill ?? THINK_SKILLS.find(candidate => candidate.name === skillName)
      if (skill === undefined || (nativeSkill !== undefined && !isModelInvocable(nativeSkill))) throw new TypeError(`hivemind-progressive-skills: unavailable skill ${skillName}`)
      return { status: 'ready', operation: 'load', skill: { name: skill.name, description: skill.description, content: skill.content, resource_base: 'resourceBase' in skill ? skill.resourceBase : undefined } }
    },
    presentCall(args) { return { card: 'generic', title: 'Use a specialized skill', kind: 'read', rawInput: String(args.operation ?? '') } },
  }))
}
