import type { ExtensionErrorEntry, ExtensionErrorSource } from '@shared/types'

/**
 * The words of an extension's error console (`ExtensionInfo.errors`, #159), shared by the
 * desktop details card and the phone's Errors sheet so the two read the same: where a line came
 * from, its place in the code, its one-line detail and the console's summary.
 */

/** Where a line came from (`ExtensionErrorSource`), as the row's description names it. */
export const ERROR_SOURCE_LABELS: Readonly<Record<ExtensionErrorSource, string>> = {
  load: 'Loading',
  worker: 'Service worker',
  page: 'Extension page',
  content: 'Content script'
}

/** The console newest first: by the latest occurrence, then by id (both grow with time). */
export function newestFirst(errors: readonly ExtensionErrorEntry[]): ExtensionErrorEntry[] {
  return [...errors].sort((a, b) => b.lastAt - a.lastAt || b.id - a.id)
}

/**
 * The script a line came from, short: the extension's own files lose their
 * `chrome-extension://<id>/` prefix (the path is the file), anything else stays whole; the
 * 1-based line follows after a colon when known. Null when the script is unknown.
 */
export function errorLocation(entry: ExtensionErrorEntry, extensionId: string): string | null {
  if (!entry.url) return null
  const own = `chrome-extension://${extensionId}/`
  const file = entry.url.startsWith(own) ? entry.url.slice(own.length) || '/' : entry.url
  return entry.line !== null ? `${file}:${entry.line}` : file
}

/**
 * The row's description under the message: the source, when it last happened, how often when
 * more than once, and the file and line when known – "Service worker · 5 min ago · ×3 ·
 * background.js:12". `relative` is the surface's relative-time formatter, so each keeps its own.
 */
export function errorDetail(
  entry: ExtensionErrorEntry,
  extensionId: string,
  relative: (timestamp: number) => string
): string {
  const parts = [ERROR_SOURCE_LABELS[entry.source], relative(entry.lastAt)]
  if (entry.count > 1) parts.push(`×${entry.count.toLocaleString()}`)
  const location = errorLocation(entry, extensionId)
  if (location) parts.push(location)
  return parts.join(' · ')
}

/** How many lines of each level the console holds (lines, not repeats). */
export function errorCounts(errors: readonly ExtensionErrorEntry[]): {
  errors: number
  warnings: number
} {
  let errorLines = 0
  let warnings = 0
  for (const entry of errors) {
    if (entry.level === 'error') errorLines++
    else warnings++
  }
  return { errors: errorLines, warnings }
}

/** "2 errors, 1 warning", "1 error", "3 warnings" – or "None" for an empty console. */
export function errorSummary(errors: readonly ExtensionErrorEntry[]): string {
  const counts = errorCounts(errors)
  const parts: string[] = []
  if (counts.errors > 0) parts.push(plural(counts.errors, 'error'))
  if (counts.warnings > 0) parts.push(plural(counts.warnings, 'warning'))
  return parts.length > 0 ? parts.join(', ') : 'None'
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`
}
