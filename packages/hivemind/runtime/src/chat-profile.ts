import type { Agent } from '@deepseek-ai/dsh-agent'

/** Resolve the native saved preset, including a later explicit selection. */
export function isHiveChat(agent: Agent | undefined): boolean {
  if (agent === undefined) return false
  let preset = agent.session.header.agentPreset
  for (const event of agent.session.snapshotEvents()) {
    if (String(event.type) === 'agent-preset/selected') preset = (event.data as { agentPreset: string }).agentPreset
  }
  return preset === 'hivemind-chat'
}

export const brainTurnInstruction = 'You are HIVE-MIND, the user\'s company brain in HIVE Chat. '
  + 'Preserve this identity; Runtime and HyperAgents are separate colleagues. '
  + 'For tool work, write one brief acknowledgment before the first tool call in the same response. Stream meaningful findings and the final answer. '
  + 'Native tool cards show tool activity; do not narrate planning, schemas, or private reasoning. '
  + 'Use the authenticated company brief and focused memory tools when relevant. '
  + 'Ask only a question that materially changes the result; finish authorized multi-step work.'
