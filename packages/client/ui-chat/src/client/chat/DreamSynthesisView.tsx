import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { discoverySections, type DreamDiscovery } from '../dream-synthesis.ts'
import css from './DreamSynthesisView.module.css'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { 'dream-flashback': DreamDiscovery }
}

/** A receipt-backed final answer, retained in the same Session as its exploration. */
export function DreamSynthesisView({ node, openPreview }: ChatNodeViewProps<'dream-synthesis'> & {
  openPreview: (discovery: DreamDiscovery) => void
}) {
  return <section className={css.root} data-dream-synthesis={node.data.runId}>
    <h2>🌙 Dream exploration</h2>
    <p className={css.prose}>{node.data.summary}</p>
    {node.data.discoveries.length === 0
      ? <p>No new supported connection was saved during this exploration.</p>
      : <><h3>Here’s what I discovered</h3>{node.data.discoveries.map((discovery, index) =>
        <article className={css.card} key={discovery.memoryId}>
          <span className={css.icon} aria-hidden="true">🌙</span>
          <div className={css.heading}><strong>{index + 1}. {discovery.title}</strong>
            <span>Saved to Flashbacks · Preview in sidebar</span></div>
          <button type="button" aria-label={`View ${discovery.title}`} className={css.preview}
            onClick={() => openPreview(discovery)}>◫</button>
          <div className={css.details}>
            <DiscoveryContent discovery={discovery} />
            <SourceList discovery={discovery} />
          </div>
        </article>)}</>}
    {node.data.next && <details><summary>Threads for the next dream</summary><p>{node.data.next}</p></details>}
  </section>
}
function DiscoveryContent({ discovery }: { discovery: DreamDiscovery }) {
  const sections = discoverySections(discovery)
  return <><p className={css.prose}>{sections.finding}</p>
    {sections.meaning && <p><strong>What it means: </strong>{sections.meaning}</p>}
    {sections.uncertainty && <p><strong>What remains uncertain: </strong>{sections.uncertainty}</p>}</>
}
function SourceList({ discovery }: { discovery: DreamDiscovery }) {
  return <details><summary>Supporting sources ({discovery.sourceIds.length})</summary>
    <ul>{discovery.sourceIds.map(id => <li key={id}>{discovery.sources?.find(source => source.id === id)?.title ?? id}<details><summary>View source</summary><p className={css.prose}>{discovery.sources?.find(source => source.id === id)?.content ?? 'Source content unavailable.'}</p><code>{id}</code></details></li>)}</ul>
    <small>Flashback memory ID: {discovery.memoryId}</small>
  </details>
}
/** Uses the native right sidebar tab; it does not create a competing overlay. */
export function DreamFlashbackPreview({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab'>) {
  const { tab } = useTabInfo()
  const discovery = tab.navigation.params as DreamDiscovery | undefined
  if (!discovery?.memoryId) return null
  return <article className={css.previewBody}><small>🌙 FLASHBACK · DERIVED INSIGHT</small>
    <h2>{discovery.title}</h2><DiscoveryContent discovery={discovery} />
    <p>Saved to Flashbacks</p><SourceList discovery={discovery} />
  </article>
}
