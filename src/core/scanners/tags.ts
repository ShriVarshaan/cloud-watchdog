// Reading single tags. Scanners store no tags, only the Name and a few that
// AWS sets itself (such as the Auto Scaling group name).

interface Tag {
  Key?: string | undefined
  Value?: string | undefined
}

/** The value of one tag, or null when it is missing or empty. */
export function tagValue(tags: readonly Tag[] | undefined, key: string): string | null {
  const value = tags?.find((entry) => entry.Key === key)?.Value
  return value ? value : null
}

/** `{ name }` when the Name tag is set, otherwise nothing, for spreading into a Resource. */
export function nameFromTags(tags: readonly Tag[] | undefined): { name?: string } {
  const name = tagValue(tags, 'Name')
  return name ? { name } : {}
}
