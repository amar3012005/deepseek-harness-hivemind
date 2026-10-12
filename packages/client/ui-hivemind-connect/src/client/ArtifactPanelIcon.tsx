/** Icon for the artifact library's native global-panel navigation row. */
import { IconBrowseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Render the artifact glyph at the edge requested by the owning sidebar. */
export function ArtifactPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconBrowseOutlineRegular size={size} />
}
