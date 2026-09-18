import type {
  ExtensionErrorEntry,
  ExtensionErrorLevel,
  ExtensionErrorSource
} from '../../shared/types'
import type { ManifestIssue } from './manifest'

/**
 * An extension's error console (`ExtensionInfo.errors`): what Chrome's extensions page shows
 * under "Errors". The ring keeps the last `ERROR_CONSOLE_CAPACITY` lines per extension, oldest
 * first; a line identical to one already in the ring (same level, source, message, script, line
 * and context) bumps that line's `count` and `lastAt` instead of taking a slot, so a listener
 * that fails on every event fills one row, not the whole console.
 *
 * The hosts feed it (`main/platform/extensionErrors.ts` from Electron's console events); this
 * module is the shared shape and bookkeeping.
 */

/** Chrome's `ErrorConsole` keeps a hundred errors per extension. */
export const ERROR_CONSOLE_CAPACITY = 100

/** A dumped object or a long stack is cut here; the app state carries every line to the chrome. */
export const ERROR_MESSAGE_MAX_LENGTH = 2000

const URL_MAX_LENGTH = 512

/** What a host reports; the ring stamps it and merges repeats. */
export interface ExtensionErrorReport {
  level: ExtensionErrorLevel
  source: ExtensionErrorSource
  message: string
  url?: string | null
  line?: number | null
  context?: string | null
}

export class ExtensionErrorRing {
  private readonly entries: ExtensionErrorEntry[] = []
  private nextId = 1

  constructor(private readonly capacity: number = ERROR_CONSOLE_CAPACITY) {}

  /**
   * Records a report at `at` (ms since epoch) and returns the entry it landed in: a new one, or
   * the identical earlier line with its `count` and `lastAt` bumped.
   */
  push(report: ExtensionErrorReport, at: number): ExtensionErrorEntry {
    const message = trim(report.message, ERROR_MESSAGE_MAX_LENGTH)
    const url = report.url ? trim(report.url, URL_MAX_LENGTH) : null
    const line = typeof report.line === 'number' && report.line > 0 ? report.line : null
    const context = report.context ? trim(report.context, URL_MAX_LENGTH) : null
    const existing = this.entries.find(
      (e) =>
        e.level === report.level &&
        e.source === report.source &&
        e.message === message &&
        e.url === url &&
        e.line === line &&
        e.context === context
    )
    if (existing) {
      existing.count += 1
      existing.lastAt = Math.max(existing.lastAt, at)
      return existing
    }
    const entry: ExtensionErrorEntry = {
      id: this.nextId++,
      level: report.level,
      source: report.source,
      message,
      url,
      line,
      context,
      at,
      lastAt: at,
      count: 1
    }
    this.entries.push(entry)
    if (this.entries.length > this.capacity)
      this.entries.splice(0, this.entries.length - this.capacity)
    return entry
  }

  /** The lines, oldest first (copies: the app state must not alias the ring). */
  list(): ExtensionErrorEntry[] {
    return this.entries.map((e) => ({ ...e }))
  }

  get size(): number {
    return this.entries.length
  }

  /** Drops the lines `predicate` picks; returns how many went. */
  remove(predicate: (entry: ExtensionErrorEntry) => boolean): number {
    const before = this.entries.length
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (predicate(this.entries[i])) this.entries.splice(i, 1)
    }
    return before - this.entries.length
  }

  clear(): void {
    this.entries.length = 0
    this.nextId = 1
  }
}

function trim(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text
}

const EXTENSION_URL = /^chrome-extension:\/\/([a-p]{32})(?=\/|$)/

/** The extension id of a `chrome-extension://` URL (scope, script, page), or null. */
export function extensionIdOfUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const match = EXTENSION_URL.exec(url)
  return match ? match[1] : null
}

/**
 * Chromium's console levels as its events carry them: the numeric scale of a worker's
 * `console-message` (0 verbose, 1 info, 2 warning, 3 error) and the named one of a page's.
 * Only warnings and errors are console material; null for the rest.
 */
export function consoleLevel(level: number | string): ExtensionErrorLevel | null {
  if (level === 3 || level === 'error') return 'error'
  if (level === 2 || level === 'warning') return 'warning'
  return null
}

/**
 * Which extension a console line belongs to, and where it came from: a line printed inside an
 * extension's own document is the extension's (`page`), whatever script printed it (the API
 * layer's "Unchecked runtime.lastError" included, as in Chrome); a line printed inside a tab
 * page by a script that is one of the extension's files is a content script's (`content`).
 * Null for lines that are nobody's: the page's own, or the chrome's.
 */
export function attributePageMessage(
  frameUrl: string | null,
  scriptUrl: string | null
): { extensionId: string; source: 'page' | 'content' } | null {
  const pageOwner = extensionIdOfUrl(frameUrl)
  if (pageOwner) return { extensionId: pageOwner, source: 'page' }
  const scriptOwner = extensionIdOfUrl(scriptUrl)
  if (scriptOwner) return { extensionId: scriptOwner, source: 'content' }
  return null
}

/**
 * A manifest issue (`validateManifest`) as a console line: Chrome lists an extension's manifest
 * warnings ("Unrecognized manifest key", a malformed match pattern) beside its runtime errors.
 */
export function manifestIssueReport(
  extensionId: string,
  issue: ManifestIssue,
  level: ExtensionErrorLevel
): ExtensionErrorReport {
  return {
    level,
    source: 'load',
    message: issue.path ? `${issue.path}: ${issue.message}` : issue.message,
    url: `chrome-extension://${extensionId}/manifest.json`,
    line: null,
    context: null
  }
}
