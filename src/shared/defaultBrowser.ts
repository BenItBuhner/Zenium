/** Version as `major.minor`: the granularity at which the default-browser prompt returns. */
export function featureVersion(version: string): string {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim())
  return match ? `${match[1]}.${match[2]}` : version.trim()
}

/**
 * Whether the "Make Zenium your default browser" strip may show. Like Chrome's periodic prompt,
 * a dismissal is remembered for the release it happened in and for its patch releases; the next
 * feature release (a new `major.minor`) asks once more.
 */
export function shouldShowDefaultBrowserPrompt(
  dismissedVersion: string | null,
  currentVersion: string
): boolean {
  if (dismissedVersion === null) return true
  return featureVersion(dismissedVersion) !== featureVersion(currentVersion)
}
