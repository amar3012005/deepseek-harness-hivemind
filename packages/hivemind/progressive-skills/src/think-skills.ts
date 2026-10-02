/** Progressive Think action guidance; scoped native registry takes precedence. */
export const THINK_SKILLS = [
  {
    'name': 'browser-use',
    'description': 'Load before reading a live page. Use Cloudflare Browser Run quick actions, not a custom crawler.',
    'content': 'Lease browser and discover the actual native browser contracts before use. Read source pages for text evidence. Capture is only proof of title, URL and screenshot, not verified page copy. Use native discovered navigation/extraction tools when web_fetch cannot read a page. Do not repeat invalid calls unchanged or invent Think browser tool names.',
  },
  {
    'name': 'composio-connected',
    'description': 'Load for connected-app work needing tool discovery, schema selection, execution, or connection recovery. Simple reads can use native tools directly.',
    'content': 'Lease connected and use hivemind_connected_task with its registered schema. Discover the authenticated connected tool and exact returned contract, then execute schema-valid arguments. Keep read and write effects distinct and follow the existing native access policy. Credentials remain server-side. Continue the same connection or approval operation; do not invent provider slugs or repeat ambiguous writes.',
  },
  {
    'name': 'social-draft',
    'description': 'Load only while writing a social post. Does not publish.',
    'content': '\n- Write from the company offer and the audience already recalled.\n- One post. One idea.\n- Stop before publish. Publishing needs approval.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'engineering-change',
    'description': 'Load only while planning one code or product change and the test that proves it.',
    'content': '\n- State the change, the test, and what must keep working.\n- Use the browser before the computer.\n- Open the computer only when the browser cannot see the surface.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'customer-report',
    'description': 'Load only while writing an account status report.',
    'content': '\n- Separate what the customer said from what the company record says.\n- Name the open issue and the next owner.\n- Do not reply to the customer from this skill.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'strategy-scenarios',
    'description': 'Load only while writing scenarios and one recommendation.',
    'content': '\n- Name the decision first.\n- Write two or three scenarios. Mark each as fact or assumption.\n- End with one recommendation and what would change it.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'seo-audit',
    'description': 'Load only while judging pages for search priorities.',
    'content': '\n- Read the company page before recommending a change.\n- Each priority needs the URL it came from.\n- Do not invent search volume.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'brand-expression',
    'description': 'Load only while writing or reviewing brand language.',
    'content': '\n- Start from the brand words already stored for this company.\n- Propose a change only when the current words fail the task.\n- Keep one voice across the artifact.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'fundraising-narrative',
    'description': 'Load only while drafting a fundraising narrative.',
    'content': '\n- Separate facts, assumptions, and the ask.\n- Every figure needs a source.\n- Do not send the narrative from this skill.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'product-brief',
    'description': 'Load only while writing a product brief.',
    'content': '\n- Start from feedback already in company memory.\n- One user, one problem, one change.\n- Mark unknowns as gaps.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'design-artifact',
    'description': 'Load only while specifying one design artifact.',
    'content': '\n- Read the brand notes before specifying color, type, or layout.\n- One artifact. Name the format.\n- Do not generate the file until the brief is accepted.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'legal-memo',
    'description': 'Load only while writing a legal memo. Does not file or send.',
    'content': '\n- Name the jurisdiction.\n- Separate the source text from the judgment.\n- An external commitment requires approval.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'finance-brief',
    'description': 'Load only while writing a finance brief.',
    'content': '\n- Separate figures, assumptions, and recommendations.\n- Every figure needs its source.\n- Do not book a transaction from this skill.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'think-company-evidence',
    'description': 'Load for focused company-memory retrieval, profile interpretation, or temporal recall. Simple lookups can call hivemind_meta directly.',
    'content': 'Use hivemind_meta from its registered contract. For profile questions use context, for stored evidence use focused recall. Company memory saves and private employee memories remain distinct; report a save only from its receipt.',
  },
  {
    'name': 'outreach-email',
    'description': 'Load only while drafting one outreach message. Does not send the message.',
    'content': '\n- Use only facts already verified about the recipient and this company.\n- One ask. One next step.\n- Stop before send. Sending needs a separate approval.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
  {
    'name': 'parallel-search',
    'description': 'Load before external web research. Run governed Parallel search and keep only URL-backed citations.',
    'content': 'Lease research and use hivemind_research_answer for independent evidence questions. Retain exact URLs, readable excerpts and source dates. Use web_fetch for specifically missing first-party evidence. A failed provider is a gap, not evidence.',
  },
  {
    'name': 'prospect-qualification',
    'description': "Load while qualifying sourced prospect accounts against the company's recalled ICP.",
    'content': "\n- Recall the company's offer and ICP before searching. Search for buyer accounts in the requested market, not only for the company's own name.\n- For each candidate, inspect its own page or a search result that names it and supports its location and fit. Include the source URL beside the account.\n- Reject an account when source does not support its location or ICP fit. Mark missing buyer details unknown; do not invent contacts, budgets, or interest.\n- Give each accepted candidate a short fit reason tied to the recalled ICP. Keep unsupported leads out of the final list.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.",
  },
  {
    'name': 'report-render',
    'description': 'Load only while writing the final report. Sets the section order and forbids unsourced claims in the findings.',
    'content': '\n- Sections, in order: Decision, Company, What was done, Findings, Gaps, Sources.\n- Every finding names the memory id or the page URL it came from.\n- Put unsourced names in Gaps.\n- Do not add a section the task did not ask for.\n\nNative Harness adaptation: use hivemind_capabilities to lease only needed lanes. Search/load instruction names through hivemind_skills; use hivemind_meta for company recall, hyperagents_memory for employee-private memory, hivemind_research_answer for bounded parallel public evidence, and web_fetch for exact source text. Discover browser contracts before calling them; browser capture alone does not establish page claims. Record native plans only for substantial company work and keep actual receipts authoritative. This is guidance, not a second execution loop or permission to perform external actions.',
  },
] as const
