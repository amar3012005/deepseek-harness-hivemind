import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'

const EMPLOYEE_HARNESS_PATH = '/hivemind/app/employee/harness'
const OUTER_BRAIN_SELECTOR = 'a[href="/hivemind/app/connectors"]'
const OUTER_ROOMS_ATTRIBUTE = 'data-os-harness-rooms'

/** The product shell owns navigation only while its employee Harness host is mounted. */
export function isExternalEmployeeHarness(pathname: string, documentRoot: ParentNode): boolean {
  const route = pathname === EMPLOYEE_HARNESS_PATH || pathname.startsWith(`${EMPLOYEE_HARNESS_PATH}/`)
  const brain = pathname === '/hivemind/app/overview' || pathname.startsWith('/hivemind/app/overview/')
  return (route && documentRoot.querySelector(`[${OUTER_ROOMS_ATTRIBUTE}]`) !== null)
    || (brain && documentRoot.querySelector(OUTER_BRAIN_SELECTOR) !== null)
}

function recordTouchesOuterRooms(record: MutationRecord): boolean {
  if (record.type === 'attributes' && record.attributeName === OUTER_ROOMS_ATTRIBUTE) return true
  if (record.type !== 'childList') return false
  for (const node of [...record.addedNodes, ...record.removedNodes]) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    const element = node as Element
    if (element.matches(`[${OUTER_ROOMS_ATTRIBUTE}], ${OUTER_BRAIN_SELECTOR}`)
      || element.querySelector(`[${OUTER_ROOMS_ATTRIBUTE}], ${OUTER_BRAIN_SELECTOR}`) !== null) return true
  }
  return false
}

/** Bind the product-owned outer route to the native frame's explicit presentation input. */
export function setupExternalEmployeeSidebar(
  layout: Pick<ILayout, 'setExternalSidebar'>,
  win: Window = window,
  doc: Document = document,
): () => void {
  const originalEmbeddedMarker = doc.documentElement.dataset.dshEmbedded
  let enabled: boolean | undefined
  const sync = (): void => {
    const next = isExternalEmployeeHarness(win.location.pathname, doc)
    if (next === enabled) return
    enabled = next
    layout.setExternalSidebar(next)
    if (next) doc.documentElement.dataset.dshEmbedded = 'true'
    else if (originalEmbeddedMarker === undefined) delete doc.documentElement.dataset.dshEmbedded
    else doc.documentElement.dataset.dshEmbedded = originalEmbeddedMarker
  }
  const observer = new MutationObserver((records) => {
    if (records.some(recordTouchesOuterRooms)) sync()
  })
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [OUTER_ROOMS_ATTRIBUTE],
  })
  win.addEventListener('popstate', sync)
  sync()
  return () => {
    observer.disconnect()
    win.removeEventListener('popstate', sync)
    layout.setExternalSidebar(false)
    if (originalEmbeddedMarker === undefined) delete doc.documentElement.dataset.dshEmbedded
    else doc.documentElement.dataset.dshEmbedded = originalEmbeddedMarker
  }
}
