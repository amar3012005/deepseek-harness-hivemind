/** Built-in HyperAgents operating playbooks. @module @deepseek-ai/dsh-hivemind-playbooks/catalog */

import { THINK_PLAYBOOKS } from './think-catalog.ts'

export type PlaybookLevel = 'global' | 'local'

/** One progressively loadable operating method. */
export interface Playbook {
  readonly id: string
  readonly version: string
  readonly level: PlaybookLevel
  readonly title: string
  readonly description: string
  readonly domains: readonly string[]
  readonly intents: readonly string[]
  /** Global doctrines that supply the operating method for this local extension. */
  readonly parentGlobalIds?: readonly string[]
  readonly generationCapabilities?: readonly string[]
  readonly fieldMethod?: string
  readonly workflowRef?: 'native:workflow'
  readonly content: string
}

export const PLAYBOOKS: readonly Playbook[] = [
  ...THINK_PLAYBOOKS,
  {
    id: 'campaign-launch', version: '1.0.0', level: 'local', title: 'Brand campaign production and launch',
    description: 'Produce and optionally launch a brand-aware campaign with assets, review, connected publishing and measurement.',
    domains: ['branding', 'marketing', 'creative'], intents: ['campaign', 'marketing', 'brand', 'launch', 'audience', 'personas', 'calendar'],
    parentGlobalIds: ['global-creative', 'global-research'], generationCapabilities: ['pdf', 'presentation', 'spreadsheet', 'image', 'web', 'video'], fieldMethod: 'campaign-launch', workflowRef: 'native:workflow',
    content: 'Choose the useful campaign stages with hivemind_field_step(method="campaign-launch"). The suggested method is evidence, Brand DNA, assets, review, approval, publish and measure. Execute only the scope requested: a campaign draft does not authorize publication or spending. Use configured generation providers and connected apps. A measurement plan is not observed campaign performance. Keep native todos current; inline employees perform selected work in the parent session.',
  },
  {
    id: 'sales-outreach', version: '1.0.0', level: 'local', title: 'Qualified sales outreach',
    description: 'Qualify prospects, create grounded messages, and continue approved outreach through connected apps.',
    domains: ['sales', 'outreach', 'partnerships'], intents: ['prospect', 'outreach', 'email', 'sequence', 'pipeline', 'proposal'],
    parentGlobalIds: ['global-outreach', 'global-research'], generationCapabilities: ['spreadsheet', 'pdf', 'presentation'], fieldMethod: 'sales-outreach', workflowRef: 'native:workflow',
    content: 'Use hivemind_field_step(method="sales-outreach") for qualification, drafting, approval, delivery and follow-up guidance. Resolve company evidence, exact contacts and the authenticated account. Use the existing connected-app continuation for OAuth and approval. Do not infer delivery from a draft or plan. Store the requested artifacts and actual action receipts.',
  },
  {
    id: 'finance-legal-review', version: '1.0.0', level: 'local', title: 'Financial and legal decision review',
    description: 'Prepare sourced financial or legal work with deterministic cash calculations and explicit external-action approval.',
    domains: ['finance', 'legal', 'compliance'], intents: ['forecast', 'budget', 'cashflow', 'contract', 'legal', 'audit', 'finance'],
    parentGlobalIds: ['global-legal-finance'], generationCapabilities: ['spreadsheet', 'pdf', 'presentation'], fieldMethod: 'finance-legal-review', workflowRef: 'native:workflow',
    content: 'Use hivemind_field_step(method="finance-legal-review") to scope, calculate, review and prepare approved execution. Ground accounts and clauses in source records. Compute money with deterministic tools; label assumptions and scenarios. Require native approval before external publication, filing, commitment or transactions. A review does not itself establish regulatory compliance.',
  },
  {
    id: 'product-design', version: '1.0.0', level: 'local', title: 'Product discovery and design',
    description: 'Turn actual customer and product evidence into testable specifications, prototypes and priorities.',
    domains: ['product', 'design', 'engineering'], intents: ['product', 'prototype', 'roadmap', 'feature', 'PRD', 'flow', 'design'],
    parentGlobalIds: ['global-research', 'global-creative'], generationCapabilities: ['web', 'presentation', 'spreadsheet', 'pdf'], fieldMethod: 'product-design', workflowRef: 'native:workflow',
    content: 'Use hivemind_field_step(method="product-design") for discovery, design and validation. Base specifications on actual capabilities and customer evidence. Deliver the requested artifact and testable acceptance criteria. Keep prototypes separate from deployed functionality.',
  },
  {
    id: 'global-research', version: '1.0.0', level: 'global', title: 'Research doctrine',
    description: 'Evidence-led research for markets, competitors, prospects, customers, regulations, and strategic questions.',
    domains: ['research', 'strategy', 'market'], intents: ['research', 'investigate', 'compare', 'discover', 'verify', 'decision', 'recommendation', 'market-entry', 'go-to-market'],
    content: 'Define the decision the research must support before gathering material. Separate company memory, user-provided material, current external evidence, and inference. Prefer primary sources for consequential claims; use multiple independent sources when the result depends on comparison or market coverage. Record source limitations, dates, conflicts, and missing evidence. Delegate independent discovery or critique only when it improves coverage. Finish with an answer that connects evidence to the user\'s decision rather than returning an undigested source list.',
  },
  {
    id: 'global-outreach', version: '1.0.0', level: 'global', title: 'Outreach doctrine',
    description: 'Company-safe outreach across email, calls, social networks, partnerships, and follow-up sequences.',
    domains: ['outreach', 'sales', 'partnerships'], intents: ['contact', 'email', 'message', 'call', 'follow-up'],
    content: 'Ground outreach in the recipient, relationship, objective, and a defensible company value proposition. Personalize with verified facts and never invent familiarity. Keep drafts distinct from delivered actions. Resolve the authenticated account and exact recipient before execution, respect approval policy, and claim delivery only from a tool receipt. Optimize for a credible next step rather than excessive persuasion.',
  },
  {
    id: 'global-creative', version: '1.0.0', level: 'global', title: 'Creative production doctrine',
    description: 'Brand-aware production of writing, campaigns, presentations, documents, images, and video.',
    domains: ['creative', 'brand', 'content'], intents: ['create', 'design', 'write', 'generate', 'render'],
    content: 'Clarify audience, desired response, channel, message hierarchy, and format. Load the organization\'s current brand context and the specialized output skill when they materially affect quality. Ground factual copy before production. Generate the most useful native artifact, inspect the rendered result when visual quality matters, revise material defects, and preserve the final artifact or generation receipt. Do not force exploratory creative work into one rigid schema.',
  },
  {
    id: 'global-legal-finance', version: '1.0.0', level: 'global', title: 'Legal and finance doctrine',
    description: 'Risk-aware legal, compliance, financial, and public-claim analysis.',
    domains: ['legal', 'finance', 'compliance'], intents: ['audit', 'model', 'review', 'forecast', 'claim', 'risk', 'regulatory'],
    content: 'Identify the jurisdiction, time basis, decision owner, and material risk. Separate verified facts, contractual text, calculations, assumptions, scenarios, and professional judgment. Prefer first-party, regulator, statutory, or authoritative financial sources. Challenge absolute or exclusivity claims. Show consequential assumptions and unresolved exposure, and require human approval for external publication, filing, commitment, or transaction.',
  },
  {
    id: 'competitor-research', version: '1.0.0', level: 'local', title: 'Competitor research',
    description: 'Compare named or discovered competitors using current, source-backed dimensions relevant to a decision.',
    domains: ['research', 'strategy', 'market'], intents: ['competitor', 'alternative', 'positioning', 'benchmark'],
    parentGlobalIds: ['global-research'],
    content: 'State the market boundary and comparison dimensions. Build a candidate set from current discovery, then verify material product, pricing, customer, geography, and positioning claims from primary sources where possible. Normalize unlike claims before comparison. Distinguish absence of evidence from evidence of absence. Conclude with implications, risks, and recommended next tests for the organization.',
  },
  {
    id: 'eu-sovereign-ai-demand', version: '1.0.0', level: 'local', title: 'European sovereign-AI demand',
    description: 'Validate European demand for sovereign AI using current adoption evidence, regulatory drivers, barriers, and product-prioritization implications.',
    domains: ['research', 'strategy', 'market', 'compliance'], intents: ['sovereign-ai', 'european-ai', 'eu-ai', 'ai-adoption', 'product-prioritization', 'bank', 'banking', 'german', 'regulated-enterprise', 'market-entry'],
    parentGlobalIds: ['global-research', 'global-legal-finance'],
    content: 'Define the target geography, customer segment, and product decision before research. Use dated primary EU, regulator, statistical, and credible adoption-report evidence; record the edition, methodology, baseline, unit, and coverage for every growth figure. Separate regulatory requirements and sovereignty concerns from demonstrated buyer demand. Identify adoption barriers by customer type, technical constraint, procurement condition, and evidence strength. Cross-check company positioning only against supplied company material and independently cited evidence; label unsupported claims as gaps. Finish with priority recommendations, rationale, constraints, counter-evidence, and the next validation needed.',
  },
  {
    id: 'prospect-discovery', version: '1.0.0', level: 'local', title: 'Prospect discovery',
    description: 'Find and qualify organizations or people against an explicit ideal-customer and geographic context.',
    domains: ['research', 'sales', 'prospecting'], intents: ['lead', 'prospect', 'client', 'account', 'contact'],
    parentGlobalIds: ['global-research'],
    content: 'Translate the request and company context into explicit qualification criteria before searching. Use geographic discovery for local businesses, broad entity discovery for market coverage, and enrichment only for selected candidates. Deduplicate entities, retain source evidence, label inferred fields, and score fit separately from contactability. Return a usable shortlist with reasons and gaps; outreach is a separate approval-aware action.',
  },
  {
    id: 'cold-email-outreach', version: '1.0.0', level: 'local', title: 'Cold email outreach',
    description: 'Research, draft, review, and optionally send credible personalized cold email.',
    domains: ['outreach', 'sales'], intents: ['cold-email', 'email', 'sequence'],
    parentGlobalIds: ['global-outreach'],
    content: 'Confirm the offer, target, evidence-backed personalization, sender identity, and desired next step. Draft a concise subject and message in the organization\'s voice. Avoid unsupported recipient claims and exaggerated company claims. Review clarity and deliverability before presenting the draft. Send only when the user asked for delivery and approval policy permits it; retain the provider receipt and never treat a draft as sent.',
  },
  {
    id: 'branded-report', version: '1.0.0', level: 'local', title: 'Branded report',
    description: 'Produce a sourced, decision-ready report or PDF using the organization’s visual identity.',
    domains: ['creative', 'research', 'reporting'], intents: ['report', 'pdf', 'document', 'brief'],
    parentGlobalIds: ['global-creative', 'global-research'],
    content: 'Establish the decision, audience, required depth, and evidence scope. Complete research before final layout. Structure the narrative around findings, implications, recommendations, caveats, and sources. Load current Brand DNA and the relevant document skill before rendering. Inspect the rendered artifact for hierarchy, overflow, legibility, source integrity, and factual drift, then revise before delivery.',
  },
  {
    id: 'investor-evidence-deck', version: '1.0.0', level: 'local', title: 'Evidence-backed investor deck',
    description: 'Research and produce an investor presentation whose company, compliance, market, and financial claims remain traceable to evidence or explicit assumptions.',
    domains: ['fundraising', 'research', 'creative', 'compliance', 'finance'], intents: ['investor', 'deck', 'fundraise', 'pitch', 'presentation'],
    parentGlobalIds: ['global-research', 'global-creative', 'global-legal-finance'],
    content: 'Establish the investor audience, funding objective, decision stage, and requested artifact format. Retrieve the current company dossier and relevant internal evidence, then independently verify public, regulatory, market, and competitive claims at the level their risk requires. Use separate employee assignments when research, compliance challenge, financial modeling, or narrative review need distinct expertise. Build a claim ledger before final production: each material statement is either supported by a cited receipt, labeled as company-provided, or presented as an explicit assumption or scenario. Never invent certifications, traction, customers, team biographies, historical finances, market figures, performance measurements, or regulatory conclusions. Load current Brand DNA and the presentation skill before creating the artifact. Render and inspect the complete deck for factual drift, citation readability, visual hierarchy, overflow, and consistency. Deliver the actual artifact when its production capability is available; otherwise return the completed sourced content and identify the exact missing rendering capability rather than substituting a generic template.',
  },
]
