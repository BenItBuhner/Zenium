import type {
  ImportKind,
  ImportKindOutcome,
  ImportProgress,
  ImportSource
} from '../../shared/types'
import { parseNetscapeHtml, type NetscapeDocument } from '../../shared/netscape'
import type { Browser } from '../browser'
import type { ImportDatabase, ImportHost } from '../platform'
import type { ZenWindow } from '../window'
import { parseImport } from '../credentials/csv'
import { parseChromiumBookmarks } from './chromiumBookmarks'
import { chromiumKeys, chromiumLogins } from './chromiumLogins'
import {
  decodeFirefoxBackup,
  firefoxBookmarksFromBackup,
  firefoxBookmarksFromPlaces,
  newestFirefoxBackup
} from './firefoxBookmarks'
import {
  chromiumHistoryVisits,
  dedupeVisits,
  firefoxHistoryVisits,
  safariHistoryVisits
} from './history'
import { historyImportSink } from './historySink'
import {
  CHROMIUM_FILES,
  FIREFOX_FILES,
  IMPORTED_FOLDER_TITLES,
  SAFARI_FILES,
  joinPath,
  sqliteCompanions
} from './locations'
import { parseSafariBookmarks } from './safariBookmarks'
import { FILE_SOURCE_IDS, discoverSources } from './sources'
import {
  dedupeByUrl,
  type ImportedBookmarks,
  type ImportedLogins,
  type ImportedVisits
} from './types'

/** A bookmarks HTML with its favicons inline runs to tens of megabytes; Chrome reads it whole. */
export const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024

export const KIND_ORDER: ImportKind[] = ['bookmarks', 'history', 'passwords']

/** Chrome's importer lock dialog, Zenium's wording: the browser named, the way out stated. */
export function lockedMessage(browserName: string): string {
  return `${browserName} is open. Close ${browserName} and try again.`
}

export function fullDiskAccessMessage(): string {
  return "Zenium needs Full Disk Access to read Safari's data. Allow it in System Settings, Privacy & Security, Full Disk Access, then try again."
}

export const VAULT_LOCKED_MESSAGE =
  'The password vault is locked. Unlock it in Settings, Passwords, then try again.'

/** A failure the user can act on; `refusal` marks the running-browser lock. */
export class ImportError extends Error {
  constructor(
    message: string,
    readonly refusal = false
  ) {
    super(message)
    this.name = 'ImportError'
  }
}

/** Error codes a file read gets when another process holds the file (or the OS denies the read). */
const LOCK_CODES = new Set([
  'EBUSY',
  'EPERM',
  'EACCES',
  'ELOCK',
  'ETXTBSY',
  'SQLITE_BUSY',
  'SQLITE_LOCKED'
])

function errorCode(error: unknown): string {
  const e = error as { code?: unknown } | null
  return e && typeof e.code === 'string' ? e.code : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emptyOutcome(): ImportKindOutcome {
  return { imported: 0, duplicates: 0, unreadable: 0, invalid: 0, error: null }
}

/**
 * Chrome's "Import bookmarks and settings" (ID-23): the sources on the machine, one import at
 * a time from a browser profile or a picked file, its progress and result as `UIState.import`.
 * Browser databases are read from a temp copy (the host's `copyToTemp`), never in place; a
 * source browser that refuses the copy or holds its profile lock is reported by name.
 */
export class ImportService {
  private progress: ImportProgress | null = null
  private abort: AbortController | null = null

  constructor(
    private readonly browser: Browser,
    private readonly now: () => number = () => Date.now()
  ) {}

  uiState(): ImportProgress | null {
    return this.progress
  }

  private get host(): ImportHost | undefined {
    return this.browser.platform.importHost
  }

  /** The sources as they are right now (a browser closed since the last call shows closed). */
  sources(): Promise<ImportSource[]> {
    return discoverSources(this.host, {
      os: this.browser.platform.info.os,
      historyWritable: historyImportSink(this.browser.history) !== null,
      passwordsAvailable: this.browser.platform.capabilities.passwords
    })
  }

  /** Whether an import is in flight. */
  get running(): boolean {
    return this.progress?.status === 'running'
  }

  async run(
    sourceId: string,
    kinds: ImportKind[],
    win?: ZenWindow
  ): Promise<ImportProgress | null> {
    if (this.running) return this.progress
    const source = (await this.sources()).find((s) => s.id === sourceId)
    if (!source) return null
    const wanted = KIND_ORDER.filter((k) => kinds.includes(k) && source.kinds.includes(k))
    if (wanted.length === 0) return null
    const progress: ImportProgress = {
      source,
      kinds: wanted,
      status: 'running',
      current: null,
      results: {},
      error: null,
      folderId: null,
      startedAt: this.now(),
      finishedAt: null
    }
    this.progress = progress
    const abort = new AbortController()
    this.abort = abort
    this.publish()
    try {
      if (source.browser === 'file') await this.runFile(progress, win)
      else await this.runBrowser(progress, abort.signal)
      progress.status = abort.signal.aborted ? 'cancelled' : progress.error ? 'failed' : 'done'
    } catch (error) {
      progress.status = 'failed'
      progress.error = messageOf(error)
    }
    progress.current = null
    progress.finishedAt = this.now()
    this.abort = null
    this.publish()
    return progress
  }

  /** Stop after the kind in flight; the kinds not reached get no result. */
  cancel(): boolean {
    if (!this.abort || !this.running || this.abort.signal.aborted) return false
    this.abort.abort()
    return true
  }

  dismiss(): void {
    if (this.running) return
    this.progress = null
    this.publish()
  }

  private publish(): void {
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Browser profiles
  // ---------------------------------------------------------------------------

  private async runBrowser(progress: ImportProgress, signal: AbortSignal): Promise<void> {
    const { source } = progress
    for (const kind of progress.kinds) {
      if (signal.aborted) return
      progress.current = kind
      this.publish()
      const outcome = emptyOutcome()
      progress.results[kind] = outcome
      try {
        if (kind === 'bookmarks') await this.importBookmarks(source, outcome, progress)
        else if (kind === 'history') await this.importHistory(source, outcome)
        else await this.importPasswords(source, outcome)
      } catch (error) {
        outcome.error = messageOf(error)
        // A lock refusal stops the run: every other kind would hit the same lock.
        if (error instanceof ImportError && error.refusal) {
          progress.error = error.message
          return
        }
      }
      this.publish()
    }
  }

  private async importBookmarks(
    source: ImportSource,
    outcome: ImportKindOutcome,
    progress: ImportProgress
  ): Promise<void> {
    const read = await this.readBookmarks(source)
    if (read.note) outcome.note = read.note
    outcome.invalid += read.result.skipped
    this.writeBookmarks(read.result, IMPORTED_FOLDER_TITLES[source.browser], outcome, progress)
  }

  private writeBookmarks(
    read: ImportedBookmarks,
    folderTitle: string,
    outcome: ImportKindOutcome,
    progress: ImportProgress
  ): void {
    const deduped = dedupeByUrl(read.items)
    outcome.duplicates += deduped.duplicates
    if (deduped.bookmarks === 0) return
    const doc: NetscapeDocument = { title: folderTitle, items: deduped.items }
    const result = this.browser.bookmarks.importDocument(doc, folderTitle)
    if (!result) return
    outcome.imported += result.bookmarks
    progress.folderId = result.folderId
  }

  private async readBookmarks(
    source: ImportSource
  ): Promise<{ result: ImportedBookmarks; note?: string }> {
    const host = this.requireHost()
    switch (source.browser) {
      case 'chrome':
      case 'chromium':
      case 'edge': {
        const text = await this.readText(source, joinPath(source.path, CHROMIUM_FILES.bookmarks))
        return { result: parseChromiumBookmarks(text, this.now()) }
      }
      case 'firefox': {
        this.refuseIfRunning(source)
        const places = joinPath(source.path, FIREFOX_FILES.places)
        if ((await host.stat(places)) === 'file') {
          try {
            return {
              result: await this.withDatabase(source, places, (db) =>
                firefoxBookmarksFromPlaces(db, this.now())
              )
            }
          } catch (error) {
            if (error instanceof ImportError && error.refusal) throw error
            // Fall through to the backup Firefox writes on its own.
          }
        }
        const dir = joinPath(source.path, FIREFOX_FILES.backups)
        const newest = newestFirefoxBackup(await host.list(dir))
        if (!newest)
          throw new ImportError('Firefox has no readable bookmarks or backups in this profile.')
        const bytes = await host.readBytes(joinPath(dir, newest))
        return {
          result: firefoxBookmarksFromBackup(decodeFirefoxBackup(bytes), this.now()),
          note: `Read from Firefox's bookmark backup ${newest}.`
        }
      }
      case 'safari': {
        const bytes = await this.readBytes(source, joinPath(source.path, SAFARI_FILES.bookmarks))
        return { result: parseSafariBookmarks(bytes) }
      }
      default:
        throw new ImportError('This source has no bookmarks.')
    }
  }

  private async importHistory(source: ImportSource, outcome: ImportKindOutcome): Promise<void> {
    const sink = historyImportSink(this.browser.history)
    if (!sink)
      throw new ImportError('Browsing history cannot be imported on this version of Zenium.')
    let read: ImportedVisits
    switch (source.browser) {
      case 'chrome':
      case 'chromium':
      case 'edge':
        read = await this.withDatabase(
          source,
          joinPath(source.path, CHROMIUM_FILES.history),
          (db) => chromiumHistoryVisits(db, this.now())
        )
        break
      case 'firefox':
        this.refuseIfRunning(source)
        read = await this.withDatabase(source, joinPath(source.path, FIREFOX_FILES.places), (db) =>
          firefoxHistoryVisits(db, this.now())
        )
        break
      case 'safari':
        read = await this.withDatabase(source, joinPath(source.path, SAFARI_FILES.history), (db) =>
          safariHistoryVisits(db, this.now())
        )
        break
      default:
        throw new ImportError('This source has no browsing history.')
    }
    outcome.invalid += read.skipped
    const deduped = dedupeVisits(read.visits)
    outcome.duplicates += deduped.duplicates
    if (deduped.visits.length === 0) return
    const written = await sink.importVisits(deduped.visits, { source: source.browserName })
    outcome.imported += written.added
    outcome.duplicates += written.skipped
  }

  private async importPasswords(source: ImportSource, outcome: ImportKindOutcome): Promise<void> {
    const host = this.requireHost()
    if (source.browser !== 'chrome' && source.browser !== 'chromium' && source.browser !== 'edge')
      throw new ImportError(source.limits.passwords ?? 'This source has no passwords to import.')
    const os = this.browser.platform.info.os
    if (os !== 'linux' && os !== 'darwin')
      throw new ImportError(source.limits.passwords ?? 'Passwords cannot be read on this system.')
    const secret = await host.safeStorageSecret(source.browser).catch(() => null)
    const keys = await chromiumKeys(os, secret)
    const read: ImportedLogins = { logins: [], unreadable: 0, invalid: 0 }
    let found = false
    for (const file of CHROMIUM_FILES.logins) {
      const path = joinPath(source.path, file)
      if ((await host.stat(path)) !== 'file') continue
      found = true
      const part = await this.withDatabase(source, path, (db) =>
        chromiumLogins(db, keys, this.now())
      )
      read.logins.push(...part.logins)
      read.unreadable += part.unreadable
      read.invalid += part.invalid
    }
    if (!found)
      throw new ImportError(`${source.browserName} has no saved passwords in this profile.`)
    outcome.unreadable += read.unreadable
    outcome.invalid += read.invalid
    if (read.unreadable > 0 && !secret)
      outcome.note =
        os === 'darwin'
          ? `${read.unreadable} ${plural(read.unreadable, 'password')} could not be opened: the Keychain did not give up ${source.browserName}'s Safe Storage key.`
          : `${read.unreadable} ${plural(read.unreadable, 'password')} could not be opened: they are protected by the system keyring, which could not be read.`
    if (read.logins.length === 0) return
    await this.ensureVaultUnlocked()
    const result = this.browser.passwords.store.importRows(
      read.logins,
      'skip',
      source.browser,
      this.now()
    )
    outcome.imported += result.added + result.replaced
    outcome.duplicates += result.skipped
    outcome.invalid += result.invalid
  }

  private async ensureVaultUnlocked(): Promise<void> {
    const passwords = this.browser.passwords
    if (passwords.store.unlocked()) return
    const gate = await passwords.unlock()
    if (gate.status !== 'ok' || !passwords.store.unlocked())
      throw new ImportError(VAULT_LOCKED_MESSAGE)
  }

  // ---------------------------------------------------------------------------
  // Reading a profile: the lock, the copy, the failures
  // ---------------------------------------------------------------------------

  private requireHost(): ImportHost {
    const host = this.host
    if (!host) throw new ImportError('This device cannot read other browsers’ profiles.')
    return host
  }

  /** Firefox's places database is held exclusively while Firefox runs: refuse up front, as Chrome does. */
  private refuseIfRunning(source: ImportSource): void {
    if (source.browser === 'firefox' && source.running)
      throw new ImportError(lockedMessage(source.browserName), true)
  }

  private async readText(source: ImportSource, path: string): Promise<string> {
    try {
      return await this.requireHost().readText(path)
    } catch (error) {
      throw this.readFailure(source, path, error)
    }
  }

  private async readBytes(source: ImportSource, path: string): Promise<Uint8Array> {
    try {
      return await this.requireHost().readBytes(path)
    } catch (error) {
      throw this.readFailure(source, path, error)
    }
  }

  /**
   * Copy the database with its `-wal` / `-shm` / `-journal` companions into a temp dir, open the
   * copy read-only, run `read`, and clean up whatever happened. A copy the source browser refuses
   * (Windows' exclusive share) becomes the lock refusal.
   */
  private async withDatabase<T>(
    source: ImportSource,
    path: string,
    read: (db: ImportDatabase) => T | Promise<T>
  ): Promise<T> {
    const host = this.requireHost()
    let dir: string | null = null
    try {
      const copy = await host.copyToTemp(sqliteCompanions(path))
      dir = copy.dir
      const main = copy.copies[0]
      if (!main)
        throw new ImportError(`${source.browserName} has no ${fileLabel(path)} in this profile.`)
      const db = await host.openSqlite(main)
      try {
        return await read(db)
      } finally {
        db.close()
      }
    } catch (error) {
      throw this.readFailure(source, path, error)
    } finally {
      if (dir) await host.removeTemp(dir).catch(() => undefined)
    }
  }

  private readFailure(source: ImportSource, path: string, error: unknown): ImportError {
    if (error instanceof ImportError) return error
    const code = errorCode(error)
    if (source.browser === 'safari' && (code === 'EPERM' || code === 'EACCES'))
      return new ImportError(fullDiskAccessMessage())
    if (source.running || LOCK_CODES.has(code) || /locked|busy/i.test(messageOf(error)))
      return new ImportError(lockedMessage(source.browserName), true)
    return new ImportError(
      `Could not read ${source.browserName}'s ${fileLabel(path)}: ${messageOf(error)}`
    )
  }

  // ---------------------------------------------------------------------------
  // Files (every host)
  // ---------------------------------------------------------------------------

  private async runFile(progress: ImportProgress, win?: ZenWindow): Promise<void> {
    const { source } = progress
    const kind = progress.kinds[0]
    progress.current = kind
    this.publish()
    const outcome = emptyOutcome()
    const isBookmarks = source.id === FILE_SOURCE_IDS.bookmarks
    const files = await this.browser.platform.dialogs.pickTextFiles(
      isBookmarks
        ? {
            title: 'Import bookmarks',
            extensions: ['html', 'htm'],
            maxBytes: MAX_IMPORT_FILE_BYTES
          }
        : {
            title: 'Import passwords from CSV',
            extensions: ['csv', 'txt'],
            maxBytes: MAX_IMPORT_FILE_BYTES
          },
      win
    )
    // The picker took the chrome's focus; see `Browser.importBookmarks`.
    win?.focusChrome()
    if (files.length === 0) {
      this.abort?.abort()
      return
    }
    progress.results[kind] = outcome
    try {
      if (isBookmarks) {
        let any = false
        for (const file of files) {
          const doc = parseNetscapeHtml(file.text)
          if (doc.items.length === 0) continue
          any = true
          this.writeBookmarks(
            { items: doc.items, skipped: 0 },
            IMPORTED_FOLDER_TITLES.file,
            outcome,
            progress
          )
        }
        if (!any) throw new ImportError('No bookmarks were found in that file.')
      } else {
        let recognised = false
        const rows: ReturnType<typeof parseImport>['rows'] = []
        let format: string | null = null
        for (const file of files) {
          const parsed = parseImport(file.text)
          if (parsed.format === null) {
            outcome.invalid += Math.max(1, parsed.invalid)
            continue
          }
          recognised = true
          format ??= parsed.format
          outcome.invalid += parsed.invalid
          rows.push(...parsed.rows)
        }
        if (!recognised) throw new ImportError('That file does not look like a password export.')
        if (rows.length) {
          await this.ensureVaultUnlocked()
          const result = this.browser.passwords.store.importRows(rows, 'skip', format, this.now())
          outcome.imported += result.added + result.replaced
          outcome.duplicates += result.skipped
          outcome.invalid += result.invalid
        }
      }
    } catch (error) {
      outcome.error = messageOf(error)
    }
  }
}

function fileLabel(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}
