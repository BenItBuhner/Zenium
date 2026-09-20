import type {
  ImportBrowser,
  ImportKind,
  ImportKindOutcome,
  ImportProgress,
  ImportSource
} from '@shared/types'

/**
 * Chrome's "Import bookmarks and settings" (ID-23) as the chrome reads it: the sources
 * `import.sources` lists grouped into the dialog's "From" menulist and its profile menulist, the
 * kinds as checkbox rows, the notices a source carries (the running browser, the recorded
 * limits) and the words for what an import did. Pure over the shared types, so the desktop
 * dialog, the Settings pane, the first-run offer and the phone's rows read one vocabulary and a
 * test needs no DOM.
 */

/** The kinds in the dialog's order with Chrome's labels ("Favorites/Bookmarks" is "Bookmarks" here). */
export const KIND_ORDER: readonly ImportKind[] = ['bookmarks', 'history', 'passwords']

export const KIND_LABEL: Record<ImportKind, string> = {
  bookmarks: 'Bookmarks',
  history: 'Browsing history',
  passwords: 'Saved passwords'
}

/** Chrome's dialog title, and its success headline. */
export const IMPORT_TITLE = 'Import bookmarks and settings'
export const IMPORT_READY = 'Your bookmarks and settings are ready'

/** The two file sources' ids (`core/import/sources.ts`, `FILE_SOURCE_IDS`). */
export const FILE_SOURCE = { bookmarks: 'file:bookmarks', passwords: 'file:passwords' } as const

/** One entry of the "From" menulist: a browser with its profiles, or one file source. */
export interface SourceGroup {
  /** The browser id, or the file source's id. */
  key: string
  browser: ImportBrowser
  /** "Google Chrome", "Bookmarks HTML file". */
  label: string
  profiles: ImportSource[]
}

/**
 * The menulist's entries in the engine's order: every profile of one browser behind one entry
 * (the profile menulist tells them apart), the file sources one entry each.
 */
export function sourceGroups(sources: readonly ImportSource[]): SourceGroup[] {
  const groups: SourceGroup[] = []
  for (const source of sources) {
    const key = source.browser === 'file' ? source.id : source.browser
    let group = groups.find((g) => g.key === key)
    if (!group) {
      group = { key, browser: source.browser, label: source.browserName, profiles: [] }
      groups.push(group)
    }
    group.profiles.push(source)
  }
  return groups
}

/** Sources that are another browser's profile (the first-run offer names these; files are not an offer). */
export function browserSources(sources: readonly ImportSource[]): ImportSource[] {
  return sources.filter((s) => s.browser !== 'file')
}

/** What the dialog picks on open: the first browser found, else the first file source. */
export function defaultGroup(groups: readonly SourceGroup[]): SourceGroup | null {
  return groups.find((g) => g.browser !== 'file') ?? groups[0] ?? null
}

/**
 * A profile's entry in the profile menulist: its name, and the account when two profiles share
 * a name (Chrome's own "Person 1" twice), else the directory as the last resort.
 */
export function profileLabel(source: ImportSource, siblings: readonly ImportSource[]): string {
  const shared = siblings.filter((s) => s.name === source.name).length > 1
  if (!shared) return source.name
  if (source.email) return `${source.name} (${source.email})`
  return `${source.name} (${source.profileId})`
}

/** "Person 1 (bennett@example.com)" for a profile with an account, else the name; browsers with one profile say nothing. */
export function sourceCaption(
  source: ImportSource,
  siblings: readonly ImportSource[]
): string | null {
  if (siblings.length < 2) return source.email ?? null
  const label = profileLabel(source, siblings)
  return source.email && !label.includes(source.email) ? `${label} · ${source.email}` : label
}

/**
 * The running-browser line (the root's scope note): Chrome and Edge still read from a copy, so
 * theirs is a notice with the way out should the copy fail; Firefox's places database is
 * refused while Firefox runs, so its line is the refusal itself, in the engine's words.
 */
export function runningNotice(source: ImportSource | null): string | null {
  if (!source || !source.running) return null
  const name = source.browserName
  if (source.browser === 'firefox') return `${name} is open. Close ${name} and try again.`
  return `${name} is open. Zenium reads a copy of its data; if the import fails, close ${name} and try again.`
}

/** The kinds a source cannot provide here, with the way round (Chrome's CSV export…). */
export function limitNotes(source: ImportSource | null): Array<{ kind: ImportKind; text: string }> {
  if (!source) return []
  return KIND_ORDER.flatMap((kind) => {
    const text = source.limits[kind]
    return text ? [{ kind, text }] : []
  })
}

/** The checkbox rows: every kind the source has or names a limit for, in the dialog's order. */
export function kindRows(
  source: ImportSource | null
): Array<{ kind: ImportKind; available: boolean }> {
  if (!source) return []
  const rows: Array<{ kind: ImportKind; available: boolean }> = []
  for (const kind of KIND_ORDER) {
    if (source.kinds.includes(kind)) rows.push({ kind, available: true })
    else if (source.limits[kind]) rows.push({ kind, available: false })
  }
  return rows
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

const ITEM: Record<ImportKind, [string, string]> = {
  bookmarks: ['bookmark', 'bookmarks'],
  history: ['visit', 'visits'],
  passwords: ['password', 'passwords']
}

/**
 * What one kind did, as the result's lines: the count that came in first, then what was
 * skipped and why, then the engine's note (a Firefox backup read, a keyring that kept its
 * secret). A kind that failed says why instead.
 */
export function outcomeLines(kind: ImportKind, outcome: ImportKindOutcome): string[] {
  if (outcome.error) return [outcome.error]
  const [one, many] = ITEM[kind]
  const lines: string[] = []
  lines.push(
    outcome.imported === 0 ? `No new ${many}` : `${plural(outcome.imported, one, many)} imported`
  )
  const skipped: string[] = []
  if (outcome.duplicates > 0)
    skipped.push(
      kind === 'history'
        ? `${outcome.duplicates.toLocaleString()} already in your history`
        : `${outcome.duplicates.toLocaleString()} already saved`
    )
  // The engine's keyring note counts the unopened ones itself, with the reason: once is enough.
  if (outcome.unreadable > 0 && !outcome.note?.includes('could not be opened'))
    skipped.push(`${outcome.unreadable.toLocaleString()} could not be opened`)
  if (outcome.invalid > 0) skipped.push(`${outcome.invalid.toLocaleString()} unusable`)
  if (skipped.length) lines.push(skipped.join(', '))
  if (outcome.note) lines.push(outcome.note)
  return lines
}

/** The kinds a finished import reports on, in the dialog's order. */
export function reportedKinds(progress: ImportProgress): ImportKind[] {
  return KIND_ORDER.filter((kind) => progress.results[kind] !== undefined)
}

/** Whether anything came in at all. */
export function importedAnything(progress: ImportProgress): boolean {
  return reportedKinds(progress).some((kind) => (progress.results[kind]?.imported ?? 0) > 0)
}

/**
 * The last import worth reporting: one that finished with something to say. A run still going
 * is not it, nor a file pick the user cancelled (stopped before any kind ran, nothing to show).
 */
export function finishedImport(progress: ImportProgress | null): ImportProgress | null {
  if (!progress || progress.status === 'running') return null
  if (progress.status === 'cancelled' && !progress.error && reportedKinds(progress).length === 0)
    return null
  return progress
}

/** The busy form's status line: what is being read right now. */
export function progressLine(progress: ImportProgress): string {
  const kind = progress.current
  if (!kind) return 'Importing…'
  return `Importing ${KIND_LABEL[kind].toLowerCase()}…`
}

/**
 * The result's one headline: Chrome's "Your bookmarks and settings are ready" when the run
 * finished; the run's own failure when nothing could be read (the lock refusal names the
 * browser); "Nothing was imported" when every kind came back empty or failed.
 */
export function resultHeadline(progress: ImportProgress): string {
  if (progress.error) return progress.error
  if (progress.status === 'cancelled') return 'Import stopped'
  if (!importedAnything(progress)) return 'Nothing was imported'
  return IMPORT_READY
}

/** "From Google Chrome (Person 1)": the result's line under the headline. */
export function resultCaption(progress: ImportProgress): string {
  const { source } = progress
  if (source.browser === 'file')
    return `From a ${source.browserName.charAt(0).toLowerCase()}${source.browserName.slice(1)}`
  const profile = source.name !== source.browserName ? ` (${source.name})` : ''
  return `From ${source.browserName}${profile}`
}

/**
 * One sentence for a row or toast: the first kind's count line, or the failure. The phone's
 * Import rows report with it.
 */
export function summaryLine(progress: ImportProgress): string {
  if (progress.error) return progress.error
  const kinds = reportedKinds(progress)
  const parts = kinds.map((kind) => outcomeLines(kind, progress.results[kind]!)[0]!)
  return parts.length ? parts.join('. ') : resultHeadline(progress)
}

/** "Google Chrome, Firefox and Safari": the browsers found, as a sentence names them. */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
