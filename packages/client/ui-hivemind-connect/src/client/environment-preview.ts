/** Existing native viewer kinds share the Preview column geometry. */
export function isEnvironmentPreviewOpen(sidebar: { isExpanded(): boolean; active(): { kind: string } | undefined } | undefined): boolean {
  if (!sidebar?.isExpanded()) return false
  const kind = sidebar.active()?.kind
  return kind === 'text' || kind === 'hivemind-artifact-preview'
    || kind === 'hivemind-workbench-preview' || kind === 'hivemind-workbench-artifacts'
    || kind === 'hivemind-workbench-computer' || kind === 'hivemind-workbench-sources'
}
