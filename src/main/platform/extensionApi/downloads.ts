import type { DownloadItem } from '../../../shared/types'
import type { DownloadService } from '../../../core/downloads'
import {
  DownloadArgumentError,
  ERROR_EMPTY_FILE,
  ERROR_FILE_ALREADY_DELETED,
  ERROR_FILE_NOT_REMOVED,
  ERROR_ICON_NOT_FOUND,
  ERROR_INVALID_ID,
  ERROR_NOT_COMPLETE,
  ERROR_NOT_DANGEROUS,
  ERROR_NOT_IN_PROGRESS,
  ERROR_NOT_RESUMABLE,
  ERROR_NO_PERMISSION,
  ERROR_OPEN_PERMISSION,
  ERROR_SHELF_PERMISSION,
  ERROR_UI_PERMISSION,
  chromeFilename,
  chromeState,
  creationShape,
  downloadDelta,
  hashDownloadId,
  normalizeDownloadOptions,
  normalizeDownloadQuery,
  normalizeSuggestion,
  quarantined,
  runDownloadQuery,
  toChromeDownloadItem,
  type ChromeDownloadItem,
  type DownloadView,
  type FilenameSuggestion
} from '../../../core/extensions/api/downloads'
import type { FilenameDeterminer, ProgrammaticDownload } from '../downloads'
import {
  ApiError,
  isInteger,
  isRecord,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/**
 * What the API needs of the platform's download host and file system, kept behind an
 * interface so the module runs against fakes.
 */
export interface DownloadBridge {
  startDownload(request: ProgrammaticDownload): Promise<DownloadItem>
  setFilenameDeterminer(determiner: FilenameDeterminer | null): void
  /** Where an in-flight download's file is meant to end up (the model has the base name only). */
  targetPath(id: string): string | null
  fileExists(path: string): boolean
  /** Delete a completed download's file; false when it could not be removed. */
  deleteFile(path: string): Promise<boolean>
  /** The OS icon for the file type at `path`, as a data URL of `size` px; null when there is none. */
  fileIcon(path: string, size: 16 | 32): Promise<string | null>
  /** Open the downloads folder in the file manager. */
  showDefaultFolder(): void
}

/** How long a listener may take to `suggest()` before its extension counts as declining. */
const DETERMINER_TIMEOUT_MS = 15_000

interface PendingDeterminer {
  extensionId: string
  resolve: (suggestion: FilenameSuggestion | null) => void
}

interface Starter {
  id: string
  name: string
}

/**
 * `chrome.downloads` over Zenium's downloads list (`core/downloads`, owned by the downloads
 * engine program): reads the records in Chrome's shape, acts through the service's own user
 * actions, starts transfers and settles file names through the platform host's hooks, and fires
 * the events from a diff of the list on the router's tick (the model commits on every change).
 * Private downloads stay invisible: extensions do not run in private sessions.
 */
export class DownloadsApi {
  /** Model id ↔ Chrome id; hashes settle collisions by probing, so ids survive restarts. */
  private readonly ids = new Map<string, number>()
  private readonly zenIds = new Map<number, string>()
  /** Downloads this run's extensions started, for `byExtensionId` / `byExtensionName`. */
  private readonly byExtension = new Map<string, Starter>()
  /** `download()` calls whose record the host has not announced yet, matched by URL as the host does. */
  private readonly starting: Array<{ url: string; by: Starter }> = []
  /** Completed files found missing or removed through `removeFile` (`exists: false`). */
  private readonly gone = new Set<string>()
  private snapshot: Map<string, ChromeDownloadItem> | null = null
  private readonly determiners = new Map<number, PendingDeterminer>()
  private determinerSeq = 0
  /** `setUiOptions({ enabled: false })` callers; recorded, the panel itself has no hook yet. */
  private readonly uiDisabledBy = new Set<string>()

  constructor(
    private readonly host: ApiHost,
    private readonly bridge: DownloadBridge,
    private readonly now: () => number = () => Date.now()
  ) {}

  readonly handlers: NamespaceHandlers = {
    download: (ctx, options) => this.download(ctx, options),
    search: (ctx, query) => this.search(ctx, query),
    pause: (ctx, id) => this.pause(ctx, id),
    resume: (ctx, id) => this.resume(ctx, id),
    cancel: (ctx, id) => this.cancel(ctx, id),
    getFileIcon: (ctx, id, options) => this.getFileIcon(ctx, id, options),
    open: (ctx, id) => this.open(ctx, id),
    show: (ctx, id) => this.show(ctx, id),
    showDefaultFolder: (ctx) => this.showDefaultFolder(ctx),
    erase: (ctx, query) => this.erase(ctx, query),
    removeFile: (ctx, id) => this.removeFile(ctx, id),
    acceptDanger: (ctx, id) => this.acceptDanger(ctx, id),
    setUiOptions: (ctx, options) => this.setUiOptions(ctx, options),
    setShelfEnabled: (ctx, enabled) => this.setShelfEnabled(ctx, enabled)
  }

  private get service(): DownloadService {
    return this.host.browser.downloads
  }

  /** Hook the host's file-name step: `onDeterminingFilename` listeners get a say on every new download. */
  attach(): void {
    this.bridge.setFilenameDeterminer((record, suggested) => this.determine(record, suggested))
  }

  // ---------------------------------------------------------------------------
  // Ids and shapes
  // ---------------------------------------------------------------------------

  chromeIdFor(zenId: string): number {
    const known = this.ids.get(zenId)
    if (known !== undefined) return known
    let id = hashDownloadId(zenId)
    while (this.zenIds.has(id)) id = (id % 0x7fffffff) + 1
    this.ids.set(zenId, id)
    this.zenIds.set(id, zenId)
    return id
  }

  private visible(): DownloadItem[] {
    return this.service.items.filter((item) => !item.private)
  }

  private view(item: DownloadItem): DownloadView {
    const view: DownloadView = {
      id: this.chromeIdFor(item.id),
      targetPath: this.bridge.targetPath(item.id),
      fileGone: this.gone.has(item.id)
    }
    const by = this.starter(item)
    if (by) view.byExtension = by
    return view
  }

  /** The extension behind a record: known, or the `download()` call still waiting on its URL. */
  private starter(item: DownloadItem): Starter | undefined {
    const known = this.byExtension.get(item.id)
    if (known) return known
    const index = this.starting.findIndex((s) => s.url === item.url)
    if (index === -1) return undefined
    const by = this.starting[index]!.by
    this.starting.splice(index, 1)
    this.byExtension.set(item.id, by)
    return by
  }

  private shape(item: DownloadItem): ChromeDownloadItem {
    return toChromeDownloadItem(item, this.view(item), this.now())
  }

  /** The record behind a Chrome id, or Chrome's refusal. */
  private lookup(raw: unknown): DownloadItem {
    if (!isInteger(raw)) throw new ApiError(ERROR_INVALID_ID)
    let zenId = this.zenIds.get(raw)
    if (zenId === undefined) {
      // Ids are hashes of the model's: a record the API never shaped still has one.
      for (const item of this.visible()) if (this.chromeIdFor(item.id) === raw) zenId = item.id
    }
    const item = zenId === undefined ? undefined : this.service.item(zenId)
    if (!item || item.private) throw new ApiError(ERROR_INVALID_ID)
    return item
  }

  private requirePermission(ext: LoadedExtension): void {
    if (!hasDownloads(this.host, ext)) throw new ApiError(ERROR_NO_PERMISSION)
  }

  /**
   * The shapes of every visible download, with `exists` re-checked on the completed ones:
   * Chrome looks for removed files on `search`, and reports what it finds through `onChanged`.
   */
  private refreshed(): ChromeDownloadItem[] {
    let changed = false
    for (const item of this.visible()) {
      if (item.state !== 'completed' || quarantined(item) || !item.savePath) continue
      if (this.gone.has(item.id) || this.bridge.fileExists(item.savePath)) continue
      this.gone.add(item.id)
      changed = true
    }
    if (changed) this.host.scheduleTick()
    return this.visible().map((item) => this.shape(item))
  }

  // ---------------------------------------------------------------------------
  // Methods
  // ---------------------------------------------------------------------------

  private async download(ctx: ApiContext, raw: unknown): Promise<number> {
    this.requirePermission(ctx.extension)
    const options = checked(() => normalizeDownloadOptions(raw))
    const request: ProgrammaticDownload = { url: options.url }
    if (Object.keys(options.headers).length > 0) request.headers = options.headers
    if (options.filename)
      request.suggestion = { filename: options.filename, conflictAction: options.conflictAction }
    if (options.saveAs) request.saveAs = true
    const pending = {
      url: options.url,
      by: { id: ctx.extensionId, name: ctx.extension.manifest.name }
    }
    this.starting.push(pending)
    let record: DownloadItem
    try {
      record = await this.bridge.startDownload(request)
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : 'NETWORK_FAILED')
    } finally {
      const index = this.starting.indexOf(pending)
      if (index !== -1) this.starting.splice(index, 1)
    }
    this.byExtension.set(record.id, pending.by)
    return this.chromeIdFor(record.id)
  }

  private search(ctx: ApiContext, raw: unknown): ChromeDownloadItem[] {
    this.requirePermission(ctx.extension)
    const query = checked(() => normalizeDownloadQuery(raw))
    return runDownloadQuery(this.refreshed(), query)
  }

  private erase(ctx: ApiContext, raw: unknown): number[] {
    this.requirePermission(ctx.extension)
    const query = checked(() => normalizeDownloadQuery(raw))
    const hits = runDownloadQuery(this.refreshed(), query)
    for (const hit of hits) {
      const zenId = this.zenIds.get(hit.id)
      // A running transfer is cancelled with its row, a finished file stays (the model's rule).
      if (zenId) this.service.remove(zenId)
    }
    return hits.map((hit) => hit.id)
  }

  private pause(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    const item = this.lookup(raw)
    if (chromeState(item) !== 'in_progress') throw new ApiError(ERROR_NOT_IN_PROGRESS)
    this.service.pause(item.id)
  }

  private resume(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    const item = this.lookup(raw)
    if (!this.shape(item).canResume) throw new ApiError(ERROR_NOT_RESUMABLE)
    this.service.resume(item.id)
  }

  /** Never an error, like Chrome: an unknown or finished download is simply left alone. */
  private cancel(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    if (!isInteger(raw)) return
    let item: DownloadItem
    try {
      item = this.lookup(raw)
    } catch {
      return
    }
    // Chrome cancels a dangerous download awaiting validation; here that is its Discard.
    if (quarantined(item)) void this.service.discard(item.id)
    else if (item.state === 'progressing' || item.state === 'paused') this.service.cancel(item.id)
  }

  private async getFileIcon(ctx: ApiContext, raw: unknown, options: unknown): Promise<string> {
    this.requirePermission(ctx.extension)
    const item = this.lookup(raw)
    let size: 16 | 32 = 32
    if (isRecord(options) && options.size !== undefined) {
      if (options.size !== 16 && options.size !== 32) {
        throw new ApiError(
          "Error at parameter 'options': Error at property 'size': Value must be one of 16, 32."
        )
      }
      size = options.size
    }
    const path = chromeFilename(item, this.bridge.targetPath(item.id))
    if (!path) throw new ApiError(ERROR_EMPTY_FILE)
    const icon = await this.bridge.fileIcon(path, size)
    if (!icon) throw new ApiError(ERROR_ICON_NOT_FOUND)
    return icon
  }

  /** Chrome asks the user before an extension opens a file (its open prompt); so does this. */
  private async open(ctx: ApiContext, raw: unknown): Promise<void> {
    this.requirePermission(ctx.extension)
    if (!this.host.grants(ctx.extensionId).permissions.includes('downloads.open'))
      throw new ApiError(ERROR_OPEN_PERMISSION)
    const item = this.lookup(raw)
    if (chromeState(item) !== 'complete') throw new ApiError(ERROR_NOT_COMPLETE)
    const ok = await this.host.confirm(
      {
        message: `Open ${item.finalName}?`,
        detail: `${ctx.extension.manifest.name} wants to open this download.`,
        okLabel: 'Open'
      },
      ctx.window
    )
    if (ok) await this.service.open(item.id)
  }

  private show(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    const item = this.lookup(raw)
    this.service.showInFolder(item.id)
  }

  private showDefaultFolder(ctx: ApiContext): void {
    this.requirePermission(ctx.extension)
    this.bridge.showDefaultFolder()
  }

  private async removeFile(ctx: ApiContext, raw: unknown): Promise<void> {
    this.requirePermission(ctx.extension)
    const item = this.lookup(raw)
    if (chromeState(item) !== 'complete') throw new ApiError(ERROR_NOT_COMPLETE)
    if (this.gone.has(item.id) || !item.savePath || !this.bridge.fileExists(item.savePath))
      throw new ApiError(ERROR_FILE_ALREADY_DELETED)
    if (!(await this.bridge.deleteFile(item.savePath))) throw new ApiError(ERROR_FILE_NOT_REMOVED)
    this.gone.add(item.id)
    this.host.scheduleTick()
  }

  /**
   * Chrome shows its danger prompt and validates or removes the download by the answer. A
   * Zenium record is dangerous once the file is quarantined (flagged, complete, not kept).
   */
  private async acceptDanger(ctx: ApiContext, raw: unknown): Promise<void> {
    this.requirePermission(ctx.extension)
    const item = this.lookup(raw)
    if (chromeState(item) !== 'in_progress') throw new ApiError(ERROR_NOT_IN_PROGRESS)
    if (!quarantined(item)) throw new ApiError(ERROR_NOT_DANGEROUS)
    const keep = await this.host.confirm(
      {
        message: `Keep ${item.finalName}?`,
        detail: item.danger.message || 'This file may harm your device.',
        okLabel: 'Keep',
        danger: true
      },
      ctx.window
    )
    if (this.service.item(item.id) !== item) return
    if (keep) await this.service.acceptDanger(item.id)
    else await this.service.discard(item.id)
  }

  private setUiOptions(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    if (!this.host.grants(ctx.extensionId).permissions.includes('downloads.ui'))
      throw new ApiError(ERROR_UI_PERMISSION)
    if (!isRecord(raw) || typeof raw.enabled !== 'boolean')
      throw new ApiError(
        "Error at parameter 'options': Error at property 'enabled': Expected boolean."
      )
    if (raw.enabled) this.uiDisabledBy.delete(ctx.extensionId)
    else this.uiDisabledBy.add(ctx.extensionId)
  }

  private setShelfEnabled(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    if (!this.host.grants(ctx.extensionId).permissions.includes('downloads.shelf'))
      throw new ApiError(ERROR_SHELF_PERMISSION)
    if (typeof raw !== 'boolean')
      throw new ApiError("Error at parameter 'enabled': Expected boolean.")
    if (raw) this.uiDisabledBy.delete(ctx.extensionId)
    else this.uiDisabledBy.add(ctx.extensionId)
  }

  /** Whether some extension asked for the download UI to stay closed. */
  get uiDisabled(): boolean {
    return this.uiDisabledBy.size > 0
  }

  // ---------------------------------------------------------------------------
  // onDeterminingFilename
  // ---------------------------------------------------------------------------

  /**
   * The host's determiner: every extension with a listener is asked once, in parallel; among
   * those that suggest a name the most recently installed wins, like Chrome.
   */
  private async determine(
    record: DownloadItem,
    suggested: string
  ): Promise<FilenameSuggestion | null> {
    if (record.private) return null
    const listening = this.host
      .allLoaded()
      .filter(
        (ext) =>
          hasDownloads(this.host, ext) &&
          this.host.registry.hasListener(ext.id, 'downloads', 'onDeterminingFilename')
      )
    if (listening.length === 0) return null
    const item: ChromeDownloadItem = { ...this.shape(record), filename: suggested }
    const answers = await Promise.all(
      listening.map(async (ext) => ({ ext, suggestion: await this.ask(ext, item) }))
    )
    const installedAt = new Map(
      this.host.browser.extensions.list().map((info) => [info.id, info.installedAt] as const)
    )
    let winner: FilenameSuggestion | null = null
    let latest = -Infinity
    for (const { ext, suggestion } of answers) {
      if (!suggestion) continue
      const at = installedAt.get(ext.id) ?? 0
      if (at >= latest) {
        latest = at
        winner = suggestion
      }
    }
    return winner
  }

  private ask(ext: LoadedExtension, item: ChromeDownloadItem): Promise<FilenameSuggestion | null> {
    return new Promise((resolve) => {
      const token = ++this.determinerSeq
      const timer = setTimeout(() => {
        this.determiners.delete(token)
        resolve(null)
      }, DETERMINER_TIMEOUT_MS)
      this.determiners.set(token, {
        extensionId: ext.id,
        resolve: (suggestion) => {
          clearTimeout(timer)
          this.determiners.delete(token)
          resolve(suggestion)
        }
      })
      this.host.dispatch(ext.id, 'downloads', 'onDeterminingFilename', [item, token], {
        wake: true
      })
    })
  }

  /** A listener's `suggest()`, relayed by the shim as the `downloads-determined` notification. */
  determined(ctx: ApiContext, payload: unknown): void {
    if (!isRecord(payload) || !isInteger(payload.token)) return
    const pending = this.determiners.get(payload.token)
    if (!pending || pending.extensionId !== ctx.extensionId) return
    pending.resolve(normalizeSuggestion(payload.suggestion))
  }

  // ---------------------------------------------------------------------------
  // Events from the list
  // ---------------------------------------------------------------------------

  /** Diff the list against the last tick: new rows, gone rows, changed fields. */
  tick(): void {
    const next = new Map<string, ChromeDownloadItem>()
    for (const item of this.visible()) next.set(item.id, this.shape(item))
    const prev = this.snapshot
    this.snapshot = next
    if (!prev) return
    if (!this.host.allLoaded().some((ext) => hasDownloads(this.host, ext))) return
    const deliver = (event: string, args: unknown[]): void => {
      this.host.broadcast('downloads', event, (ext) => (hasDownloads(this.host, ext) ? args : null))
    }
    for (const [zenId, before] of prev) if (!next.has(zenId)) deliver('onErased', [before.id])
    for (const [zenId, after] of next) {
      let before = prev.get(zenId)
      if (!before) {
        // A row that settled before a tick saw it is created `in_progress` and then changed, in
        // Chrome's order, rather than born settled.
        before = after.state === 'in_progress' ? after : creationShape(after)
        deliver('onCreated', [before])
      }
      const delta = downloadDelta(before, after)
      if (delta) deliver('onChanged', [delta])
    }
  }

  /** No extension is loaded: forget the baseline, the next one starts from the list as it is. */
  reset(): void {
    this.snapshot = null
  }
}

function hasDownloads(host: ApiHost, ext: LoadedExtension): boolean {
  return host.grants(ext.id).permissions.includes('downloads')
}

/** Chrome's argument errors become `runtime.lastError` messages, verbatim. */
function checked<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof DownloadArgumentError) throw new ApiError(error.message)
    throw error
  }
}
