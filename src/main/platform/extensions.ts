import {
  WebContentsView,
  app,
  dialog,
  nativeImage,
  net,
  webContents,
  type Extension,
  type Session
} from 'electron'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type {
  ExtensionInfo,
  ExtensionSource,
  ExtensionUpdateState,
  Rect,
  SidePanelInfo,
  Suggestion
} from '../../shared/types'
import { JsonStore } from '../../core/store/JsonStore'
import type { Browser } from '../../core/browser'
import type {
  ExtensionHost,
  KeyEventInput,
  MenuItemTemplate,
  PageContextParams
} from '../../core/platform'
import type { ZenWindow } from '../../core/window'
import {
  checkForUpdates,
  installFromCrx,
  type ExtensionPackage,
  type UpdateCheckResult
} from '../../core/extensions/install'
import { manifestIssueReport } from '../../core/extensions/errorConsole'
import type { ConfirmInstall, InstallConfirmation } from '../../core/extensions/hostStore'
import { isManagedPath } from '../../core/extensions/installLayout'
import { stripJsonComments, validateManifest } from '../../core/extensions/manifest'
import {
  newWarnings,
  permissionWarningLines,
  permissionWarnings,
  type WarningPlatform
} from '../../core/extensions/permissionMessages'
import {
  manifestFields,
  migrateRegistry,
  newRecord,
  newTabOverrideUrl,
  setNewTabOverride,
  withManifest,
  type ExtensionRecord,
  type ExtensionRegistry
} from '../../core/extensions/registry'
import { STORE_UPDATE_URLS, isExtensionId, type StoreId } from '../../core/extensions/store'
import {
  NO_PREVIOUS_BEGIN_INSTALL_ERROR,
  USER_CANCELLED_ERROR,
  installStatusFor,
  type BeginInstallDetails,
  type WebstoreBeginInstallOutcome,
  type WebstoreInstallStatus
} from '../../core/extensions/webstorePrivate'
import {
  downloadFromStores,
  downloadUpdate,
  electronStoreFetch,
  idForUnpackedPath,
  packageFromFile,
  parseStoreRef,
  pruneOldVersions,
  removeInstalledFiles,
  storeLabel,
  sweepStagingDirs,
  writePackage
} from './extensionStore'
import type { ExtensionApiHooks } from './extensionApi'
import { ExtensionErrorConsole } from './extensionErrors'
import type { SessionManager } from './sessions'
import type { ElectronWindow } from './window'

interface Manifest {
  name?: string
  version?: string
  description?: string
  manifest_version?: number
  icons?: Record<string, string>
  action?: { default_popup?: string; default_icon?: string | Record<string, string> }
  browser_action?: { default_popup?: string; default_icon?: string | Record<string, string> }
}

const POPUP_WIDTH = 380
const POPUP_MAX_HEIGHT = 600

/** Chrome checks about every five hours; the first check waits for the browser to settle. */
const UPDATE_CHECK_STARTUP_DELAY_MS = 45_000
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 60 * 1000
/** How long an approval from the store page's prompt stays valid for the install that follows. */
const WEBSTORE_APPROVAL_TTL_MS = 10 * 60 * 1000
const ICON_FETCH_TIMEOUT_MS = 5_000

/** The prompt's shape is shared with the Android host (`core/extensions/hostStore.ts`). */
export type { ConfirmInstall, InstallConfirmation }

export type InstallOutcome =
  | { status: 'installed'; record: ExtensionRecord }
  | { status: 'cancelled' }
  | { status: 'in-progress' }

export interface InstallMeta {
  source: ExtensionSource
  publisher: ExtensionRecord['publisher']
  updateUrl: string | null
}

export type RegistryEvent =
  | { type: 'installed'; id: string }
  | { type: 'updated'; id: string }
  | { type: 'uninstalled'; id: string }
  | { type: 'enabled'; id: string }
  | { type: 'disabled'; id: string }
  /** The user allowed (or stopped allowing) the extension in private windows. */
  | { type: 'allowPrivate'; id: string; allowed: boolean }

interface UpdateInfo {
  state: ExtensionUpdateState
  availableVersion: string | null
  error: string | null
  checkedAt: number | null
}

const NO_UPDATE_INFO: UpdateInfo = {
  state: 'unknown',
  availableVersion: null,
  error: null,
  checkedAt: null
}

/**
 * Chrome extensions in Electron: installed from the Chrome Web Store or Edge Add-ons (verified
 * CRX3 packages unpacked under `<userData>/extensions/<id>/<version>/`), sideloaded from `.crx`
 * and `.zip` files, or loaded unpacked from a folder. Every extension is loaded into every
 * persistent container session so content scripts run in all containers; the registry
 * (`extensions.json`) remembers them across restarts, and store installs update through their
 * store on Chrome's schedule. Browser-action popups are shown from the toolbar since Electron has
 * no extension UI of its own.
 *
 * Hook points for the chrome.* API layer: `onLoaded` / `onUnloaded` fire per session, and
 * `loaded(id)` looks up a running extension.
 */
export class ExtensionService implements ExtensionHost {
  /** `<userData>/extensions`: where store and file installs live. */
  readonly root: string
  private registry: ExtensionRegistry
  private readonly store: JsonStore<ExtensionRegistry>
  private readonly loadedById = new Map<string, Extension>()
  /** Why an extension is not running (`ExtensionInfo.error`): the load's failure message. */
  private readonly errors = new Map<string, string>()
  /** Chrome's "Errors" per extension (`ExtensionInfo.errors`), for the extensions the registry knows. */
  private readonly console = new ExtensionErrorConsole({
    accept: (id) => this.record(id) !== undefined
  })
  private readonly updates = new Map<string, UpdateInfo>()
  /** Ids with an install or update in flight. */
  private readonly busy = new Set<string>()
  /** Loads in flight, by path (see `load`). */
  private readonly loading = new Map<string, Promise<void>>()
  /** Approvals the store pages' prompt produced, consumed by `completeInstall`. */
  private readonly approvals = new Map<
    string,
    { warnings: string[]; expires: number; store: StoreId }
  >()
  private readonly loadedListeners = new Set<(ext: Extension, ses: Session) => void>()
  private readonly unloadedListeners = new Set<(id: string) => void>()
  private readonly changeListeners = new Set<(event: RegistryEvent) => void>()
  private readonly iconCache = new Map<string, string | null>()
  private popup: { view: WebContentsView; win: ZenWindow } | null = null
  private checking: Promise<void> | null = null
  private updateTimer: ReturnType<typeof setInterval> | null = null
  /** The chrome.* API layer (`platform/extensionApi`): toolbar state and click routing. */
  private api: ExtensionApiHooks | null = null

  /**
   * Shows the install prompt and resolves with the user's decision. The default is a native
   * message box; the chrome replaces it with its own panel without touching the install flow.
   */
  confirmInstall: ConfirmInstall = (request, win) => this.nativeConfirm(request, win)

  constructor(
    private readonly browser: Browser,
    private readonly sessions: SessionManager,
    userDataDir: string
  ) {
    this.root = join(userDataDir, 'extensions')
    this.store = new JsonStore<ExtensionRegistry>(browser.platform.io, 'extensions.json', 300)
    this.registry = migrateRegistry(
      this.store.readSync(),
      { idForPath: idForUnpackedPath, readManifest },
      Date.now()
    )
    // Before any window exists: the popup, options and background documents and the tab pages
    // running content scripts all print through their WebContents.
    this.console.install({
      allWebContents: () => webContents.getAllWebContents(),
      onWebContentsCreated: (listener) =>
        app.on('web-contents-created', (_event, contents) => listener(contents))
    })
    this.console.onChange(() => this.browser.state.commitVolatile())
  }

  attachApi(api: ExtensionApiHooks): void {
    this.api = api
  }

  async start(): Promise<void> {
    await sweepStagingDirs(this.root).catch(() => [])
    for (const record of this.registry.extensions) if (record.enabled) await this.load(record)
    this.browser.state.commitVolatile()
    this.scheduleUpdateChecks()
  }

  // ---------------------------------------------------------------------------
  // Hook points for the chrome.* API layer
  // ---------------------------------------------------------------------------

  /** The running extension with this id (in the first persistent session), if loaded. */
  loaded(id: string): Extension | undefined {
    return this.loadedById.get(id)
  }

  /** Fires once per session an extension is loaded into; returns the unsubscribe function. */
  onLoaded(listener: (ext: Extension, ses: Session) => void): () => void {
    this.loadedListeners.add(listener)
    return () => this.loadedListeners.delete(listener)
  }

  /** Fires once when an extension is removed from its sessions; returns the unsubscribe function. */
  onUnloaded(listener: (id: string) => void): () => void {
    this.unloadedListeners.add(listener)
    return () => this.unloadedListeners.delete(listener)
  }

  /** Registry changes (install, update, uninstall, enable, disable); returns the unsubscribe function. */
  onChange(listener: (event: RegistryEvent) => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  record(id: string): ExtensionRecord | undefined {
    return this.registry.extensions.find((r) => r.id === id)
  }

  records(): readonly ExtensionRecord[] {
    return this.registry.extensions
  }

  // ---------------------------------------------------------------------------
  // Loading into sessions
  // ---------------------------------------------------------------------------

  /**
   * Load into every persistent session so content scripts run in all containers. `start()` and
   * the session hook's `attachSession()` overlap at boot; a second `loadExtension` for a path
   * whose first one is still in flight makes Chromium activate the extension twice (two worker
   * registrations), so one load per record runs at a time.
   */
  private load(record: ExtensionRecord): Promise<void> {
    const inFlight = this.loading.get(record.path)
    if (inFlight) return inFlight
    const task = this.loadIntoSessions(record).finally(() => this.loading.delete(record.path))
    this.loading.set(record.path, task)
    return task
  }

  private async loadIntoSessions(record: ExtensionRecord): Promise<void> {
    this.errors.delete(record.id)
    // A load (not a further session joining) starts the console's load lines over: Chrome keeps
    // an extension's runtime errors across a reload and replaces its manifest ones.
    const fresh = !this.loadedById.has(record.id)
    if (fresh) this.console.remove(record.id, (entry) => entry.source === 'load')
    if (!existsSync(join(record.path, 'manifest.json'))) {
      this.loadFailed(record, 'manifest.json not found')
      return
    }
    if (fresh) this.reportManifestWarnings(record)
    for (const [, ses] of this.sessions.persistent()) {
      try {
        const ext =
          ses.extensions.getAllExtensions().find((e) => e.path === record.path) ??
          (await ses.extensions.loadExtension(record.path, {
            allowFileAccess: record.allowFileAccess
          }))
        // Electron derives the id itself (from `manifest.key` or the path); trust what it says.
        if (ext.id !== record.id) this.rekey(record, ext.id)
        this.backfillNewTabPage(record, ext.manifest)
        if (!this.loadedById.has(ext.id)) this.loadedById.set(ext.id, ext)
        for (const listener of this.loadedListeners) listener(ext, ses)
      } catch (error) {
        this.loadFailed(record, (error as Error).message)
      }
    }
  }

  private loadFailed(record: ExtensionRecord, message: string): void {
    this.errors.set(record.id, message)
    this.console.report(record.id, {
      level: 'error',
      source: 'load',
      message,
      url: `chrome-extension://${record.id}/manifest.json`,
      context: record.path
    })
  }

  /** What Chrome lists as the install's warnings: unknown keys, malformed patterns and the like. */
  private reportManifestWarnings(record: ExtensionRecord): void {
    let raw: unknown
    try {
      raw = JSON.parse(stripJsonComments(readFileSync(join(record.path, 'manifest.json'), 'utf8')))
    } catch {
      return
    }
    for (const issue of validateManifest(raw).warnings)
      this.console.report(record.id, manifestIssueReport(record.id, issue, 'warning'))
  }

  private unload(record: ExtensionRecord): void {
    const ext = this.loadedById.get(record.id)
    if (!ext) return
    for (const [, ses] of this.sessions.persistent()) {
      try {
        ses.extensions.removeExtension(ext.id)
      } catch {
        /* not loaded in this session */
      }
    }
    this.loadedById.delete(record.id)
    for (const listener of this.unloadedListeners) listener(record.id)
  }

  /** Records written before `newTabPage` existed learn theirs from the manifest Electron loaded. */
  private backfillNewTabPage(record: ExtensionRecord, manifest: unknown): void {
    if (record.newTabPage !== null) return
    const page = manifestFields(manifest).newTabPage
    if (!page) return
    record.newTabPage = page
    this.persist()
  }

  private rekey(record: ExtensionRecord, id: string): void {
    console.warn(`[zen] extensions: ${record.id} loads as ${id} (${record.path})`)
    for (const map of [this.errors, this.updates] as Array<Map<string, unknown>>) {
      const value = map.get(record.id)
      map.delete(record.id)
      if (value !== undefined) map.set(id, value)
    }
    this.console.rekey(record.id, id)
    record.id = id
    this.persist()
  }

  /** A new container session appeared: hear its workers' console and bring the enabled extensions along. */
  async attachSession(ses: Session): Promise<void> {
    this.console.attachSession(ses)
    for (const record of this.registry.extensions) if (record.enabled) await this.load(record)
  }

  // ---------------------------------------------------------------------------
  // What the chrome sees
  // ---------------------------------------------------------------------------

  list(): ExtensionInfo[] {
    return this.registry.extensions.map((record) => {
      const ext = this.loadedById.get(record.id)
      const manifest = (ext?.manifest as Manifest | undefined) ?? readManifest(record.path)
      const update = this.updates.get(record.id) ?? NO_UPDATE_INFO
      const commands = ext && this.api ? this.api.commandsInfo(ext.id) : null
      return {
        id: record.id,
        name: ext?.name || record.name || manifest?.name || basename(record.path) || 'Extension',
        version: ext?.version ?? record.version,
        description: manifest?.description ?? record.description,
        path: record.path,
        enabled: record.enabled,
        icon: this.icon(record.path, record.version, manifest),
        popup: record.popup,
        error: this.errors.get(record.id) ?? null,
        source: record.source,
        publisher: record.publisher,
        updateUrl: record.updateUrl,
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
        pinned: record.pinned,
        allowFileAccess: record.allowFileAccess,
        allowPrivate: record.allowPrivate,
        manifestVersion: record.manifestVersion,
        permissions: record.permissions,
        hostPermissions: record.hostPermissions,
        optionsPage: record.optionsPage,
        newTabPage: record.newTabPage,
        newTabOverride: record.newTabOverride,
        warnings: permissionWarningLines(manifest ?? {}, warningPlatform()),
        pendingWarnings: record.pendingWarnings,
        updateState: update.state,
        availableVersion: update.availableVersion,
        updateError: update.error,
        updateCheckedAt: update.checkedAt,
        action: (ext && this.api ? this.api.actionState(ext.id) : null) ?? undefined,
        ...(commands ? { commands: commands.commands, commandConflicts: commands.conflicts } : {}),
        errors: this.console.list(record.id)
      }
    })
  }

  /** Chrome's "Clear all" on the extension's errors page. */
  clearErrors(id: string): void {
    const record = this.record(id)
    if (!record) return
    this.console.clear(record.id)
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Menus and keys (the chrome.* layer answers; nothing without it)
  // ---------------------------------------------------------------------------

  pageContextMenuItems(tabId: string, params: PageContextParams): MenuItemTemplate[] {
    return this.api ? this.api.pageContextMenuItems(tabId, params) : []
  }

  actionContextMenuItems(id: string, win: ZenWindow): MenuItemTemplate[] {
    const record = this.record(id)
    if (!record || !this.loadedById.has(record.id)) return []
    return this.api ? this.api.actionContextMenuItems(record.id, win) : []
  }

  handleKey(input: KeyEventInput, win: ZenWindow): boolean {
    return this.api ? this.api.handleKey(input, win) : false
  }

  private icon(path: string, version: string, manifest: Manifest | null): string | null {
    const key = `${path}\u0000${version}`
    let icon = this.iconCache.get(key)
    if (icon === undefined) {
      icon = iconDataUrl(path, manifest)
      this.iconCache.set(key, icon)
    }
    return icon
  }

  // ---------------------------------------------------------------------------
  // Unpacked folders
  // ---------------------------------------------------------------------------

  async addFromDialog(win: ZenWindow): Promise<void> {
    const result = await dialog.showOpenDialog((win.host as ElectronWindow).win, {
      title: 'Load unpacked extension',
      properties: ['openDirectory'],
      buttonLabel: 'Load extension'
    })
    if (result.canceled || !result.filePaths[0]) return
    await this.add(result.filePaths[0], win)
  }

  async add(path: string, win?: ZenWindow): Promise<void> {
    if (this.registry.extensions.some((e) => e.path === path)) {
      this.browser.toast('This extension is already installed.', 'info', win)
      return
    }
    const manifest = readManifest(path)
    if (!manifest) {
      this.browser.toast('That folder has no manifest.json.', 'error', win)
      return
    }
    const record = newRecord({
      id: idForUnpackedPath(path),
      source: 'unpacked',
      path,
      manifest,
      now: Date.now()
    })
    this.registry.extensions.push(record)
    await this.load(record)
    this.persist()
    const error = this.errors.get(record.id)
    this.browser.toast(
      error ? `Could not load extension: ${error}` : `Loaded ${record.name || 'extension'}`,
      error ? 'error' : 'info',
      win
    )
    this.emit({ type: 'installed', id: record.id })
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Installing packages (store, .crx, .zip)
  // ---------------------------------------------------------------------------

  async installFromFileDialog(win: ZenWindow): Promise<void> {
    const result = await dialog.showOpenDialog((win.host as ElectronWindow).win, {
      title: 'Install extension from file',
      properties: ['openFile'],
      filters: [{ name: 'Extension packages', extensions: ['crx', 'zip'] }],
      buttonLabel: 'Install'
    })
    if (result.canceled || !result.filePaths[0]) return
    await this.installFromFile(result.filePaths[0], win)
  }

  /** Installs a `.crx` (verified; unsigned or tampered packages are refused) or an unsigned `.zip`. */
  async installFromFile(path: string, win?: ZenWindow): Promise<void> {
    const name = basename(path)
    const started = Date.now()
    try {
      const bytes = new Uint8Array(await fs.readFile(path))
      const { pkg, kind } = await packageFromFile(name, bytes, { locale: app.getLocale() })
      console.log(
        `[zen] extensions: read ${name} as ${pkg.id} ${pkg.version} (${kind}, ${pkg.files.length} files, ${elapsed(started)})`
      )
      const outcome = await this.installPackage(
        pkg,
        {
          source: kind,
          publisher: pkg.signed ? pkg.publisher : null,
          updateUrl: pkg.manifest.update_url ?? null
        },
        { confirm: true, win }
      )
      this.toastOutcome(outcome, pkg, win)
    } catch (error) {
      const message = (error as Error).message
      console.warn(`[zen] extensions: could not install ${name}:`, message)
      this.browser.toast(`Could not install ${name}: ${message}`, 'error', win)
    }
  }

  /** Installs from the Chrome Web Store or Edge Add-ons by id or listing URL. */
  async installFromStore(ref: string, store: StoreId | null, win?: ZenWindow): Promise<void> {
    const parsed = parseStoreRef(ref)
    if (!parsed) {
      this.browser.toast('Enter an extension id or a store listing URL.', 'error', win)
      return
    }
    const existing = this.record(parsed.id)
    if (existing) {
      this.browser.toast(`${existing.name || 'This extension'} is already installed.`, 'info', win)
      return
    }
    try {
      const { pkg, store: from } = await this.downloadPackage(parsed.id, store ?? parsed.store)
      const outcome = await this.installPackage(
        pkg,
        { source: from, publisher: pkg.publisher, updateUrl: STORE_UPDATE_URLS[from] },
        { confirm: true, win }
      )
      this.toastOutcome(outcome, pkg, win)
    } catch (error) {
      const message = (error as Error).message
      console.warn(`[zen] extensions: could not install ${parsed.id}:`, message)
      this.browser.toast(`Could not install extension: ${message}`, 'error', win)
    }
  }

  private async downloadPackage(
    id: string,
    preferred: StoreId | null
  ): Promise<{ pkg: ExtensionPackage; store: StoreId }> {
    const started = Date.now()
    const download = await downloadFromStores(
      electronStoreFetch,
      id,
      preferred,
      process.versions.chrome
    )
    const downloaded = Date.now()
    const pkg = await installFromCrx(download.bytes, { expectedId: id, locale: app.getLocale() })
    const skipped = download.skipped
      .map((s) => ` (${storeLabel(s.store)}: HTTP ${s.status})`)
      .join('')
    console.log(
      `[zen] extensions: downloaded ${id} ${pkg.version} from ${storeLabel(download.store)}${skipped}: ${download.bytes.length} bytes in ${elapsed(started, downloaded)}, verified ${pkg.publisher} signature and unpacked ${pkg.files.length} files in ${elapsed(downloaded)}`
    )
    return { pkg, store: download.store }
  }

  private toastOutcome(outcome: InstallOutcome, pkg: ExtensionPackage, win?: ZenWindow): void {
    if (outcome.status === 'in-progress')
      this.browser.toast(`${pkg.manifest.name} is already being installed.`, 'info', win)
    else if (outcome.status === 'installed') {
      const error = this.errors.get(outcome.record.id)
      this.browser.toast(
        error
          ? `Installed ${pkg.manifest.name}, but it could not be loaded: ${error}`
          : `Added ${pkg.manifest.name} ${pkg.version}`,
        error ? 'error' : 'info',
        win
      )
    }
  }

  /**
   * The one install path: confirm (unless already approved), write the version directory, swap
   * the registry record, load, prune older versions. A failed load of an update rolls back to the
   * version that was running.
   */
  async installPackage(
    pkg: ExtensionPackage,
    meta: InstallMeta,
    options: { confirm: boolean; win?: ZenWindow }
  ): Promise<InstallOutcome> {
    if (this.busy.has(pkg.id)) return { status: 'in-progress' }
    this.busy.add(pkg.id)
    try {
      const existing = this.record(pkg.id)
      if (options.confirm) {
        const ok = await this.confirmInstall(
          {
            kind: existing ? 'update' : 'install',
            name: pkg.manifest.name,
            icon: await packageIcon(pkg),
            warnings: permissionWarningLines(pkg.manifest, warningPlatform()),
            source: meta.source
          },
          options.win
        )
        if (!ok) return { status: 'cancelled' }
      }
      const started = Date.now()
      const dir = await writePackage(this.root, pkg)
      console.log(
        `[zen] extensions: wrote ${pkg.id} ${pkg.version} to ${dir} in ${elapsed(started)}`
      )
      const now = Date.now()
      const record = existing
        ? withManifest(existing, pkg.manifest, {
            source: meta.source,
            path: dir,
            publisher: meta.publisher,
            updateUrl: meta.updateUrl,
            updatedAt: now
          })
        : newRecord({
            id: pkg.id,
            source: meta.source,
            path: dir,
            manifest: pkg.manifest,
            now,
            publisher: meta.publisher,
            updateUrl: meta.updateUrl
          })
      if (existing) this.unload(existing)
      this.replace(record)
      if (record.enabled) await this.load(record)
      const error = this.errors.get(record.id)
      if (error && existing && existing.path !== dir) {
        console.warn(
          `[zen] extensions: ${pkg.id} ${pkg.version} failed to load, keeping ${existing.version}:`,
          error
        )
        this.replace(existing)
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
        if (existing.enabled) await this.load(existing)
        this.persist()
        this.browser.state.commitVolatile()
        throw new Error(error)
      }
      if (existing && isManagedPath(this.root, existing.path) && existing.path !== dir) {
        const pruned = await pruneOldVersions(this.root, record.id, dir).catch(() => [])
        if (pruned.length > 0) console.log(`[zen] extensions: pruned ${pruned.join(', ')}`)
      }
      this.persist()
      this.emit({ type: existing ? 'updated' : 'installed', id: record.id })
      this.browser.state.commitVolatile()
      return { status: 'installed', record }
    } finally {
      this.busy.delete(pkg.id)
    }
  }

  private replace(record: ExtensionRecord): void {
    const index = this.registry.extensions.findIndex((r) => r.id === record.id)
    if (index >= 0) this.registry.extensions[index] = record
    else this.registry.extensions.push(record)
  }

  // ---------------------------------------------------------------------------
  // Management
  // ---------------------------------------------------------------------------

  /** Chrome's "Remove <name>?" question, asked before a page (the store) may uninstall. */
  confirmUninstall(record: ExtensionRecord, win?: ZenWindow): Promise<boolean> {
    return this.browser.platform.dialogs.confirm(
      {
        message: `Remove "${record.name || 'this extension'}"?`,
        okLabel: 'Remove',
        cancelLabel: 'Cancel',
        danger: true
      },
      win
    )
  }

  async remove(id: string): Promise<void> {
    const record = this.record(id) ?? this.registry.extensions.find((r) => r.path === id)
    if (!record) return
    this.unload(record)
    this.registry.extensions = this.registry.extensions.filter((r) => r !== record)
    this.errors.delete(record.id)
    this.console.forget(record.id)
    this.updates.delete(record.id)
    if (record.source !== 'unpacked' && isManagedPath(this.root, record.path))
      await removeInstalledFiles(this.root, record.id).catch((error: Error) =>
        console.warn(`[zen] extensions: could not delete ${record.path}:`, error.message)
      )
    this.persist()
    this.emit({ type: 'uninstalled', id: record.id })
    this.browser.state.commitVolatile()
  }

  async setEnabled(id: string, enabled: boolean, win?: ZenWindow): Promise<void> {
    const record = this.record(id)
    if (!record || record.enabled === enabled) return
    if (enabled && record.pendingWarnings && record.pendingWarnings.length > 0) {
      const ok = await this.confirmInstall(
        {
          kind: 'permissions',
          name: record.name,
          icon: this.icon(record.path, record.version, readManifest(record.path)),
          warnings: record.pendingWarnings,
          source: record.source
        },
        win
      )
      if (!ok) return
      record.pendingWarnings = null
    }
    record.enabled = enabled
    if (enabled) await this.load(record)
    else this.unload(record)
    this.persist()
    this.emit({ type: enabled ? 'enabled' : 'disabled', id: record.id })
    this.browser.state.commitVolatile()
  }

  setPinned(id: string, pinned: boolean): void {
    const record = this.record(id)
    if (!record || record.pinned === pinned) return
    record.pinned = pinned
    this.persist()
    this.browser.state.commitVolatile()
  }

  setNewTabOverride(id: string, enabled: boolean): void {
    if (setNewTabOverride(this.registry.extensions, id, enabled).length === 0) return
    this.persist()
    this.browser.state.commitVolatile()
  }

  newTabUrl(): string | null {
    for (const record of this.registry.extensions) {
      const url = newTabOverrideUrl(record)
      // A record that failed to load has no page to show; the URL bar is better than an error.
      if (url && this.loadedById.has(record.id)) return url
    }
    return null
  }

  /**
   * Chrome's "Allow in Incognito": lets the extension's request rules and listeners reach the
   * private window's session. The private session loads no extension, so this is the only
   * effect for now.
   */
  setAllowPrivate(id: string, allowed: boolean): void {
    const record = this.record(id)
    if (!record || record.allowPrivate === allowed) return
    record.allowPrivate = allowed
    this.persist()
    this.emit({ type: 'allowPrivate', id: record.id, allowed })
    this.browser.state.commitVolatile()
  }

  /** Unload and load again, picking up changes an unpacked folder saw on disk. */
  async reload(id: string): Promise<void> {
    const record = this.record(id)
    if (!record) return
    this.unload(record)
    if (record.source === 'unpacked') {
      const manifest = readManifest(record.path)
      if (manifest) this.replace(withManifest(record, manifest))
    }
    this.iconCache.delete(`${record.path}\u0000${record.version}`)
    const current = this.record(id) ?? record
    if (current.enabled) await this.load(current)
    this.persist()
    this.browser.state.commitVolatile()
  }

  openOptions(id: string, win: ZenWindow): void {
    const record = this.record(id)
    if (!record) return
    if (!record.optionsPage) {
      this.browser.toast(`${record.name || 'This extension'} has no options page.`, 'info', win)
      return
    }
    this.browser.tabs.createTab(
      { url: `chrome-extension://${record.id}/${record.optionsPage}`, active: true },
      win
    )
  }

  // ---------------------------------------------------------------------------
  // Updates
  // ---------------------------------------------------------------------------

  private scheduleUpdateChecks(): void {
    const first = setTimeout(() => void this.checkForUpdates(), UPDATE_CHECK_STARTUP_DELAY_MS)
    first.unref?.()
    this.updateTimer = setInterval(() => void this.checkForUpdates(), UPDATE_CHECK_INTERVAL_MS)
    this.updateTimer.unref?.()
  }

  /** Extensions that update: store installs and packages with an `update_url`, unless pinned. */
  private updatable(): ExtensionRecord[] {
    return this.registry.extensions.filter(
      (r) => !r.pinned && r.source !== 'unpacked' && r.updateUrl !== null && isExtensionId(r.id)
    )
  }

  /** Checks every updatable extension and installs what the update servers offer. */
  checkForUpdates(win?: ZenWindow): Promise<void> {
    if (this.checking) return this.checking
    this.checking = this.runUpdateCheck(this.updatable(), win).finally(() => {
      this.checking = null
    })
    return this.checking
  }

  /** Checks (and installs) an update for one extension. */
  async update(id: string, win?: ZenWindow): Promise<void> {
    const record = this.record(id)
    if (!record) return
    if (!this.updatable().includes(record)) {
      this.browser.toast(
        record.pinned
          ? `${record.name} is pinned to version ${record.version}.`
          : `${record.name} has no update source.`,
        'info',
        win
      )
      return
    }
    await this.runUpdateCheck([record], win)
  }

  private async runUpdateCheck(records: ExtensionRecord[], win?: ZenWindow): Promise<void> {
    const interactive = win !== undefined
    const started = Date.now()
    if (records.length === 0) {
      this.registry.lastUpdateCheck = started
      this.persist()
      if (interactive) this.browser.toast('No installed extension can be updated.', 'info', win)
      return
    }
    const results = await checkForUpdates(
      electronStoreFetch,
      records.map((r) => ({
        id: r.id,
        version: r.version,
        updateUrl: r.updateUrl,
        store: storeOf(r.source)
      })),
      { chromiumVersion: process.versions.chrome }
    )
    const checkedAt = Date.now()
    this.registry.lastUpdateCheck = checkedAt
    let installed = 0
    let failed = 0
    for (const record of records) {
      const result = results.get(record.id) ?? { status: 'error' as const, reason: 'no-response' }
      console.log(
        `[zen] extensions: update check ${record.id} ${record.version} (${record.source}): ${describe(result)}`
      )
      if (result.status === 'update-available') {
        this.updates.set(record.id, {
          state: 'updating',
          availableVersion: result.version,
          error: null,
          checkedAt
        })
        this.browser.state.commitVolatile()
        try {
          await this.applyUpdate(record, result)
          installed += 1
          this.updates.set(record.id, {
            state: 'up-to-date',
            availableVersion: null,
            error: null,
            checkedAt
          })
        } catch (error) {
          failed += 1
          const message = (error as Error).message
          console.warn(`[zen] extensions: update of ${record.id} failed:`, message)
          this.updates.set(record.id, {
            state: 'error',
            availableVersion: result.version,
            error: message,
            checkedAt
          })
        }
      } else if (result.status === 'up-to-date') {
        this.updates.set(record.id, {
          state: 'up-to-date',
          availableVersion: null,
          error: null,
          checkedAt
        })
      } else {
        this.updates.set(record.id, {
          state: 'error',
          availableVersion: null,
          error: result.reason,
          checkedAt
        })
      }
    }
    console.log(
      `[zen] extensions: checked ${records.length} extension(s) for updates in ${elapsed(started)}: ${installed} updated, ${failed} failed`
    )
    this.persist()
    this.browser.state.commitVolatile()
    if (interactive) {
      const summary =
        installed > 0
          ? `Updated ${installed} extension${installed === 1 ? '' : 's'}.`
          : failed > 0
            ? 'An extension update failed.'
            : 'All extensions are up to date.'
      this.browser.toast(summary, failed > 0 && installed === 0 ? 'error' : 'info', win)
    }
  }

  /**
   * Downloads and installs an update. Like Chrome, an update that asks for more than the user
   * approved is installed but left disabled until the new permissions are accepted.
   */
  private async applyUpdate(
    record: ExtensionRecord,
    update: Extract<UpdateCheckResult, { status: 'update-available' }>
  ): Promise<void> {
    const started = Date.now()
    const bytes = await downloadUpdate(electronStoreFetch, update)
    const pkg = await installFromCrx(bytes, { expectedId: record.id, locale: app.getLocale() })
    console.log(
      `[zen] extensions: downloaded update ${record.id} ${record.version} -> ${pkg.version} (${bytes.length} bytes, sha256 ${update.sha256 ? 'verified' : 'not announced'}) in ${elapsed(started)}`
    )
    const before = permissionWarnings(readManifest(record.path) ?? {}, warningPlatform())
    const after = permissionWarnings(pkg.manifest, warningPlatform())
    const added = newWarnings(before, after).map((w) => w.message)
    const outcome = await this.installPackage(
      pkg,
      { source: record.source, publisher: pkg.publisher, updateUrl: record.updateUrl },
      { confirm: false }
    )
    if (outcome.status !== 'installed') throw new Error(`Update ${outcome.status}`)
    if (added.length > 0) {
      console.log(
        `[zen] extensions: ${record.id} ${pkg.version} asks for new permissions; disabled until approved`
      )
      outcome.record.pendingWarnings = added
      outcome.record.enabled = false
      this.unload(outcome.record)
      this.persist()
      this.emit({ type: 'disabled', id: record.id })
    }
  }

  // ---------------------------------------------------------------------------
  // The store pages (chrome.webstorePrivate)
  // ---------------------------------------------------------------------------

  /**
   * `beginInstallWithManifest3`: prompt with the manifest the page attached and remember the
   * approval, together with the store whose page asked; the page follows up with
   * `completeInstall`, which downloads from that store first.
   */
  async webstoreBeginInstall(
    details: BeginInstallDetails,
    store: StoreId,
    win?: ZenWindow
  ): Promise<WebstoreBeginInstallOutcome> {
    if (this.record(details.id))
      return { result: 'already_installed', message: 'This item is already installed.' }
    if (this.busy.has(details.id))
      return { result: 'install_in_progress', message: 'This item is already being installed.' }
    const manifest = details.manifest ?? {}
    const warnings = permissionWarningLines(manifest, warningPlatform())
    const name =
      details.localizedName ??
      (typeof manifest.name === 'string' ? manifest.name : null) ??
      details.id
    const ok = await this.confirmInstall(
      {
        kind: 'install',
        name,
        icon: await fetchIconDataUrl(details.iconUrl),
        warnings,
        source: store
      },
      win
    )
    if (!ok) return { result: 'user_cancelled', message: USER_CANCELLED_ERROR }
    this.approvals.set(details.id, {
      warnings,
      expires: Date.now() + WEBSTORE_APPROVAL_TTL_MS,
      store
    })
    return { result: '' }
  }

  /** `completeInstall`: download (from the approving page's store first), verify and load. */
  async webstoreCompleteInstall(id: string, win?: ZenWindow): Promise<{ error?: string }> {
    const approval = this.approvals.get(id)
    this.approvals.delete(id)
    if (!approval || approval.expires < Date.now())
      return { error: `${id}${NO_PREVIOUS_BEGIN_INSTALL_ERROR}` }
    if (this.record(id)) return { error: 'This item is already installed.' }
    try {
      const { pkg, store } = await this.downloadPackage(id, approval.store)
      // The page's manifest is what the user approved; a package that asks for more is shown again.
      const actual = permissionWarningLines(pkg.manifest, warningPlatform())
      const increased = actual.some((w) => !approval.warnings.includes(w))
      const outcome = await this.installPackage(
        pkg,
        { source: store, publisher: pkg.publisher, updateUrl: STORE_UPDATE_URLS[store] },
        { confirm: increased, win }
      )
      if (outcome.status === 'cancelled') return { error: USER_CANCELLED_ERROR }
      if (outcome.status === 'in-progress')
        return { error: 'This item is already being installed.' }
      const loadError = this.errors.get(id)
      if (loadError) return { error: loadError }
      this.browser.toast(`Added ${pkg.manifest.name} ${pkg.version}`, 'info', win)
      return {}
    } catch (error) {
      const message = (error as Error).message
      console.warn(`[zen] extensions: store page install of ${id} failed:`, message)
      return { error: message }
    }
  }

  webstoreInstallStatus(id: string): WebstoreInstallStatus {
    return installStatusFor(this.record(id))
  }

  // ---------------------------------------------------------------------------
  // Install prompt
  // ---------------------------------------------------------------------------

  private async nativeConfirm(request: InstallConfirmation, win?: ZenWindow): Promise<boolean> {
    const lines = request.warnings.map((w) => `\u2022 ${w}`)
    const message =
      request.kind === 'permissions'
        ? `"${request.name}" needs new permissions`
        : request.kind === 'update'
          ? `Update "${request.name}"?`
          : `Add "${request.name}"?`
    const detail =
      lines.length > 0 ? `It can:\n${lines.join('\n')}` : 'It needs no special permissions.'
    const buttons =
      request.kind === 'permissions'
        ? ['Allow', 'Cancel']
        : request.kind === 'update'
          ? ['Update extension', 'Cancel']
          : ['Add extension', 'Cancel']
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Zenium',
      message,
      detail,
      buttons,
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      icon: request.icon ? nativeImage.createFromDataURL(request.icon) : undefined
    }
    const bw = browserWindowOf(win)
    const result = bw
      ? await dialog.showMessageBox(bw, options)
      : await dialog.showMessageBox(options)
    return result.response === 0
  }

  // ---------------------------------------------------------------------------
  // Browser-action popups
  // ---------------------------------------------------------------------------

  openPopup(id: string, anchor: Rect, win: ZenWindow): void {
    this.closePopup()
    const record = this.record(id) ?? this.registry.extensions.find((r) => r.path === id)
    const ext = record ? this.loadedById.get(record.id) : undefined
    if (!record || !ext) return
    // `chrome.action.setPopup` overrides the manifest; an empty popup fires `action.onClicked`.
    const popupPath = this.api ? this.api.popupForClick(ext.id, win) : record.popup
    if (!popupPath) return
    const ses = this.sessions.persistent()[0]?.[1]
    if (!ses) return
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // The API layer's preload must reach iframes the popup embeds.
        nodeIntegrationInSubFrames: true
      }
    })
    view.setBackgroundColor('#00000000')
    view.setBorderRadius(12)
    const bw = (win.host as ElectronWindow).win
    const contentBounds = bw.getContentBounds()
    const place = (height: number): void => {
      const width = POPUP_WIDTH
      const x = Math.max(
        8,
        Math.min(anchor.x + anchor.width - width, contentBounds.width - width - 8)
      )
      const y = Math.min(anchor.y + anchor.height + 6, contentBounds.height - height - 8)
      view.setBounds({ x: Math.round(x), y: Math.round(y), width, height: Math.round(height) })
    }
    place(200)
    bw.contentView.addChildView(view)
    this.popup = { view, win }
    const wc = view.webContents
    wc.on('dom-ready', () => {
      void wc
        .executeJavaScript(
          'Math.min(document.documentElement.scrollHeight, document.body.scrollHeight || 1e9)',
          true
        )
        .then((h) => {
          if (this.popup?.view !== view) return
          place(Math.max(80, Math.min(POPUP_MAX_HEIGHT, Number(h) + 8 || 200)))
        })
        .catch(() => undefined)
      wc.focus()
    })
    wc.on('blur', () => setTimeout(() => this.popup?.view === view && this.closePopup(), 120))
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        this.closePopup()
      }
    })
    wc.setWindowOpenHandler(({ url }) => {
      // Extension pages (options, dashboards) open as tabs like any site the popup links to.
      if (/^(https?|chrome-extension):/.test(url))
        this.browser.tabs.createTab({ url, active: true }, win)
      this.closePopup()
      return { action: 'deny' }
    })
    void wc
      .loadURL(`chrome-extension://${ext.id}/${popupPath.replace(/^\/+/, '')}`)
      .catch(() => undefined)
  }

  closePopup(): void {
    if (!this.popup) return
    const { view, win } = this.popup
    this.popup = null
    if (win.alive) (win.host as ElectronWindow).win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  // ---------------------------------------------------------------------------
  // Side panels (hosted by the chrome.* layer; nothing without it)
  // ---------------------------------------------------------------------------

  sidePanel(win: ZenWindow): SidePanelInfo | null {
    return this.api ? this.api.sidePanelInfo(win) : null
  }

  toggleSidePanel(id: string, win: ZenWindow): void {
    const record = this.record(id)
    if (!record || !this.loadedById.has(record.id) || !this.api) return
    this.api.toggleSidePanel(record.id, win)
  }

  closeSidePanel(win: ZenWindow): void {
    this.api?.closeSidePanel(win)
  }

  placeSidePanel(win: ZenWindow, rect: Rect | null): void {
    this.api?.placeSidePanel(win, rect)
  }

  // ---------------------------------------------------------------------------
  // Omnibox keywords (the chrome.* layer's)
  // ---------------------------------------------------------------------------

  async omniboxSuggest(input: string, win: ZenWindow): Promise<Suggestion[] | null> {
    return this.api ? this.api.omniboxSuggest(input, win) : null
  }

  omniboxSubmit(input: string, newTab: boolean, background: boolean, win: ZenWindow): boolean {
    return this.api ? this.api.omniboxSubmit(input, newTab, background, win) : false
  }

  omniboxCancel(win: ZenWindow): void {
    this.api?.omniboxCancel(win)
  }

  omniboxDeleteSuggestion(input: string): void {
    this.api?.omniboxDeleteSuggestion(input)
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private emit(event: RegistryEvent): void {
    for (const listener of this.changeListeners) listener(event)
  }

  private persist(): void {
    this.store.write(this.registry)
  }

  flushSync(): void {
    if (this.updateTimer) clearInterval(this.updateTimer)
    this.updateTimer = null
    this.store.flushSync()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function storeOf(source: ExtensionSource): StoreId | null {
  return source === 'chrome-web-store' || source === 'edge-add-ons' ? source : null
}

function describe(result: UpdateCheckResult): string {
  if (result.status === 'update-available')
    return `${result.version} available (${result.size ?? '?'} bytes, sha256 ${result.sha256 ?? 'none'}) at ${result.codebase}`
  if (result.status === 'up-to-date') return 'up to date'
  return `error (${result.reason})`
}

function elapsed(from: number, to = Date.now()): string {
  return `${to - from} ms`
}

export function warningPlatform(): WarningPlatform {
  switch (process.platform) {
    case 'win32':
      return 'win'
    case 'darwin':
      return 'mac'
    case 'linux':
      return 'linux'
    default:
      return 'other'
  }
}

function browserWindowOf(win: ZenWindow | undefined): Electron.BrowserWindow | undefined {
  const host = win?.host as ElectronWindow | undefined
  return host?.alive ? host.win : undefined
}

export function readManifest(path: string): Manifest | null {
  try {
    return JSON.parse(
      stripJsonComments(readFileSync(join(path, 'manifest.json'), 'utf8'))
    ) as Manifest
  } catch {
    return null
  }
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

/** The manifest's icon candidates, largest first: the action icon, then the extension icons. */
function iconCandidates(manifest: Manifest): string[] {
  const action = manifest.action ?? manifest.browser_action
  const candidates: Record<string, string> = {}
  if (typeof action?.default_icon === 'string') candidates['0'] = action.default_icon
  else if (action?.default_icon) Object.assign(candidates, action.default_icon)
  if (Object.keys(candidates).length === 0 && manifest.icons)
    Object.assign(candidates, manifest.icons)
  const sizes = Object.keys(candidates)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
  const pick = sizes.find((s) => s >= 32) ?? sizes[sizes.length - 1]
  const rel = pick === undefined ? Object.values(candidates)[0] : candidates[String(pick)]
  return rel ? [rel.replace(/^\/+/, '')] : []
}

function iconDataUrl(path: string, manifest: Manifest | null): string | null {
  if (!manifest) return null
  for (const rel of iconCandidates(manifest)) {
    try {
      const file = join(path, rel)
      const mime = IMAGE_MIME[extname(file).toLowerCase()] ?? 'image/png'
      return `data:${mime};base64,${readFileSync(file).toString('base64')}`
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** The icon of a package that is not on disk yet, read from its files. */
async function packageIcon(pkg: ExtensionPackage): Promise<string | null> {
  for (const rel of iconCandidates(pkg.manifest as Manifest)) {
    const file = pkg.files.find((f) => f.path === rel)
    if (!file) continue
    try {
      const mime = IMAGE_MIME[extname(rel).toLowerCase()] ?? 'image/png'
      return `data:${mime};base64,${Buffer.from(await file.bytes()).toString('base64')}`
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** The store page's icon URL for the prompt; failures just leave the prompt without an icon. */
async function fetchIconDataUrl(url: string | null): Promise<string | null> {
  if (!url || !/^https:/.test(url)) return null
  try {
    const response = await net.fetch(url, { signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS) })
    if (!response.ok) return null
    const mime = response.headers.get('content-type')?.split(';')[0] ?? 'image/png'
    if (!mime.startsWith('image/')) return null
    return `data:${mime};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
  } catch {
    return null
  }
}
