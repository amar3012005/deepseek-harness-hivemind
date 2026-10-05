/** A projected visible bubble identity; technical rows leave the group unchanged. */
export interface AvatarGroupItem { key: string; speaker?: string; boundary?: boolean }

/**
 * Return the final bubble of each consecutive sender group without changing message order.
 * @param items - Chronologically projected bubble identities and human boundaries.
 * @returns Stable keys whose bubble owns the visible avatar.
 */
export function avatarGroupEnds(items: readonly AvatarGroupItem[]): ReadonlySet<string> {
  const ends = new Set<string>()
  let last: AvatarGroupItem | undefined
  for (const item of items) {
    if (item.boundary) { if (last) ends.add(last.key); last = undefined }
    if (item.speaker === undefined) continue
    if (last && last.speaker !== item.speaker) ends.add(last.key)
    last = item
  }
  if (last) ends.add(last.key)
  return ends
}
