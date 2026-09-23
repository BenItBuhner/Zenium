/**
 * The open-source licences list (Settings › About › Open-source licences, the `zen://licences`
 * page; Chrome's chrome://credits): what the renderer's page shows for each package the build
 * carries. The list itself is generated at build time by `scripts/licences.ts`, a Vite plugin
 * both hosts' configs run, and reaches the page as the `virtual:zenium-licences` module
 * (`LicenceEntry[]`, sorted), imported lazily so its few hundred kilobytes of text are their
 * own chunk. Chromium's own credits – Electron's twenty-megabyte `LICENSES.chromium.html` – are
 * not an entry: the desktop's main process serves that document at `CHROMIUM_LICENCES_URL`
 * (`src/main/platform/licences.ts`), a `zen://` document and never a registered page, and the
 * page's Chromium row opens it in a tab of its own. The Android chrome, running on the device's
 * WebView, lists its packages alone.
 */
export interface LicenceEntry {
  /** The package's name as `package.json` has it (`electron` for the framework itself). */
  name: string
  version: string
  /** The declared licence (`license`, SPDX-ish), `''` when the package declares none. */
  licence: string
  /** The homepage, else the repository as a browsable URL. */
  url?: string
  /** The licence file's text, when the package ships one. */
  text?: string
}

/** The host of the Chromium credits document the desktop's main process serves. */
export const CHROMIUM_LICENCES_HOST = 'chromium-licences'
export const CHROMIUM_LICENCES_URL = `zen://${CHROMIUM_LICENCES_HOST}`

/**
 * Whether an entry answers a search: every whitespace-separated term of `query` occurs in the
 * name, the version or the licence's name, case-insensitively; an empty query matches all.
 */
export function matchesLicence(entry: LicenceEntry, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = `${entry.name} ${entry.version} ${entry.licence}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/** A row's second line: the version and the licence's name, or what stands where the licence would. */
export function licenceLine(entry: LicenceEntry): string {
  const parts: string[] = []
  if (entry.version) parts.push(entry.version)
  parts.push(entry.licence || (entry.text ? 'Licence below' : 'No licence declared'))
  return parts.join(' · ')
}

/** The page's order: by name without regard to case, then by version, numerically. */
export function sortLicences(entries: readonly LicenceEntry[]): LicenceEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
      a.version.localeCompare(b.version, 'en', { numeric: true })
  )
}
