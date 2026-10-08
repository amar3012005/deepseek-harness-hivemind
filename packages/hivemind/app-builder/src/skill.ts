/** On-demand CRM authoring instructions owned by the native skill registry. */
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/** Discoverable build guidance for organization operational workspaces. */
export const crmBuilderSkill: SkillRegistration = {
  name: 'create-crm',
  description: 'Build or update your organization CRM from a natural-language request using draft, validation, preview and publication tools.',
  whenToUse: 'The user asks to create a CRM, companies/contacts/deals workspace, or change its fields and views. @create CRM is an authoring request, not executable code.',
  source: 'bundled',
  provider: 'hivemind-app-builder',
  content: `# Build an organization CRM

Use the user's original requirements to prepare an AppSpec version 1. Existing Runtime and HyperAgents retain ownership of planning and delegation. Do not alter profiles, runtimes, Prisma schemas or generated executable code.

Before calling any hivemind_app_* tool, call hivemind_capabilities with operation lease and capabilities [apps]. This reveals the installed original tool schemas on the next model step. If the receipt contains no hivemind_app_* tools, organization App Runtime is unavailable in this session; explain the missing capability and stop. Do not lease connected, workspace or unrelated lanes to compensate. Reset the capability lease when this phase is complete.

1. Understand the user's entities, fields, relationships and intended work. Ask only for required missing decisions. Default to a small useful companies/contacts/deals workspace when that matches the request.
2. Use stable lowercase identifiers and recognizable display names. Supported fields are text, number, date, enum, boolean and reference. Dates use YYYY-MM-DD. Reference fields require targetEntityId; enum fields require options. Views are table, kanban and record. Kanban requires groupByFieldId naming an enum field. Workflow definitions are not supported in AppSpec v1.
3. For an earlier or existing CRM, recover its identity yourself: call hivemind_app_list by recognizable name, or browse with no query, following nextCursor with after as needed. Use published=true when the user identifies a previously published app. Match actual returned names and versions; if several apps match, ask which named workspace they mean. Never ask the user to find an internal app UUID, guess app_id from a name, or create a duplicate to replace a missing ID. Then call hivemind_app_get with the exact returned UUID to refresh its current version and preserve all retained definitions. hivemind_app_patch replaces the complete spec using expected_version; it is not a JSON patch. Incompatible schema changes need a separate data migration.
4. Choose a stable operation_id for each mutation. Reuse the exact payload and operation_id when reconciling an interrupted write. Never blindly retry with a new ID. Versions, membership and permissions are enforced by Core.
5. Call hivemind_app_create_draft or hivemind_app_patch, then hivemind_app_validate and hivemind_app_preview. Explain what the draft contains and what remains unsupported. Preview returns declarative data, not a code deployment.
6. Publish only when the user has requested publication or approved the concrete preview. Call hivemind_app_publish with the current expected_version and report publication only after its confirmed receipt.
7. Record writes use field IDs from app_get. Only local fields can be written; external/derived fields remain read-only. Do not claim integrations, triggers or automations exist just because a mapping was declared.

Final answer: name the application and current draft/published version, describe its entities and views, link its preview when supplied by the UI, and clearly identify remaining steps. Keep organization records separate from Company Brain memory writes. Project-scoped sessions are not authorized for organization CRM access.
`,
}
