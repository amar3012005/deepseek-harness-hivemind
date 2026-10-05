const presented = new Set<string>()

/** Mounting history is not a live receipt. Clock skew conservatively leaves the explicit button. */
export function claimLiveArtifactPreview(
  key: string, receiptTime: number, registeredAt: number, turnStatus: string | undefined,
): boolean {
  if (turnStatus !== 'open' || receiptTime <= registeredAt || presented.has(key)) return false
  presented.add(key)
  return true
}
