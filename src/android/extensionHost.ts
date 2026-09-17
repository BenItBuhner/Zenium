import type { ExtensionInfo, ExtensionSource, ExtensionUpdateState, Rect } from '@shared/types'
import type { Browser } from '@core/browser'
import type { ExtensionHost } from '@core/platform'
import type { ZenWindow } from '@core/window'
import { JsonStore } from '@core/store/JsonStore'
import { base64Encode } from '@core/extensions/bytes'
import { parseCrxHeader } from '@core/extensions/crx'
import {
  checkForUpdates,
  installFromCrx,
  type ExtensionPackage,
  type UpdateCheckResult
} from '@core/extensions/install'
import {
  downloadFromStores,
  downloadUpdate,
  iconCandidates,
  imageMime,
  installPromptText,
  packageFromFile,
  packageIcon,
  parseStoreRef,
  storeLabel,
  zipManifestOverride,
  type ConfirmInstall,
  type IconManifest,
  type InstallConfirmation
} from '@core/extensions/hostStore'
import { isManagedPath } from '@core/extensions/installLayout'
import { stripJsonComments } from '@core/extensions/manifest'
import {
  newWarnings,
  permissionWarningLines,
  permissionWarnings,
  type PermissionWarningSource
} from '@core/extensions/permissionMessages'
import {
  migrateRegistry,
  newRecord,
  withManifest,
  type ExtensionRecord,
  type ExtensionRegistry
} from '@core/extensions/registry'
import {
  STORE_UPDATE_URLS,
  isExtensionId,
  type StoreFetch,
  type StoreId
} from '@core/extensions/store'
import { noRuntimeHooks, type ExtensionRuntimeHooks } from './extensionRuntimeHooks'
import type { AndroidExtensionStoreIo, PackageHandle } from './extensionStoreIo'

/** Chrome checks about every five hours; the first check waits for the browser to settle. */
export const UPDATE_CHECK_STARTUP_DELAY_MS = 45_000
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 60 * 1000

/**
 * The Chromium version the stores are told about. The system WebView may be years behind the
 * desktop app (an API 34 image ships Chromium 113); asking with its version would fetch older
 * packages than the desktop installs, or none where an extension names a `minimum_chrome_version`
 * above it. The desktop's version is the floor, so both hosts install the same package.
 */
export const MIN_STORE_CHROMIUM_VERSION = '152.0.0.0'

/** The Chromium version to send to the stores: the WebView's when newer, else the floor. */
export function storeChromiumVersion(
  userAgent: string,
  floor = MIN_STORE_CHROMIUM_VERSION
): string {
  const match = /Chrome\/(\d+(?:\.\d+){0,3})/.exec(userAgent)
  if (!match) return floor
  const seen = match[1].split('.').map(Number)
  const min = floor.split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    const a = seen[i] ?? 0
    const b = min[i] ?? 0
    if (a !== b) return a > b ? padVersion(match[1]) : floor
  }
  return floor
}

function padVersion(version: string): string {
  const parts = version.split('.')
  while (parts.length < 4) parts.push('0')
  return parts.join('.')
}

/** What a `.crx` or `.zip` file is called when the picker or the sending app did not say. */
export function packageFileName(name: string, bytes: Uint8Array): string {
  if (/\.(crx|zip)$/i.test(name)) return name
  const base = name.replace(/\.[^.]*$/, '') || 'package'
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x43 &&
    bytes[1] === 0x72 &&
    bytes[2] === 0x32 &&
    bytes[3] === 0x34
  )
    return `${base}.crx`
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return `${base}.zip`
  return name
}

/**
 * A stable id for a record whose id must be made up (the v1 registry schema, which Android never
 * wrote): FNV-1a of the path spread over the a..p alphabet. Sync because `migrateRegistry` is.
 */
export function idForUnpackedPath(path: string): string {
  let hash = 0x811c9dc5
  let out = ''
  for (let round = 0; out.length < 32; round++) {
    const text = `${path}\u0000${round}`
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    for (let shift = 0; shift < 32 && out.length < 32; shift += 4)
      out += String.fromCharCode(97 + ((hash >>> shift) & 0xf))
  }
  return out
}

export type InstallOutcome =
  | { status: 'installed'; record: ExtensionRecord }
  | { status: 'cancelled' }
  | { status: 'in-progress' }

export interface InstallMeta {
  source: ExtensionSource
  publisher: ExtensionRecord['publisher']
  updateUrl: string | null
}

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

/** What the host remembers about an installed version besides its record. */
interface Details {
  manifest: PermissionWarningSource & IconManifest & { name?: string; description?: string }
  icon: string | null
}

export interface AndroidExtensionsOptions {
  /** The runtime that runs extensions; the default keeps installs as files and records. */
  hooks?: ExtensionRuntimeHooks
  /** Full Chromium version for store requests (see `storeChromiumVersion`). */
  chromiumVersion?: string
  /** UI locale for manifest localisation (`navigator.language` by default). */
  locale?: string | null
  now?: () => number
  /** Timers for the update schedule; injectable so tests run the schedule by hand. */
  setTimeout?: (fn: () => void, ms: number) => unknown
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

/**
 * Chrome extensions on Android, the store half: installs from the Chrome Web Store and Edge
 * Add-ons (verified CRX3 packages), from `.crx` and `.zip` files picked or sent to Zenium, with
 * the registry (`extensions.json`, the desktop's schema) remembering them, updates on Chrome's
 * schedule while the app is in the foreground, and the permission-increase gate Chrome applies to
 * updates. Kotlin (`ext/ExtensionStore.kt`) moves the bytes: downloads land in a temporary file
 * the chrome document reads through the asset loader, and the archive is unpacked from that
 * file straight into `files/zen/extensions/<id>/<version>/`. Running the extensions is the
 * runtime's job, reached through `ExtensionRuntimeHooks`.
 */
export class AndroidExtensions implements ExtensionHost {
  private registry: ExtensionRegistry
  private readonly store: JsonStore<ExtensionRegistry>
  private readonly hooks: ExtensionRuntimeHooks
  private readonly chromiumVersion: string
  private readonly locale: string | null
  private readonly now: () => number
  private readonly timers: Required<
    Pick<AndroidExtensionsOptions, 'setTimeout' | 'setInterval' | 'clearInterval'>
  >
  /** Ids the runtime is running right now. */
  private readonly attached = new Set<string>()
  private readonly errors = new Map<string, string>()
  private readonly updates = new Map<string, UpdateInfo>()
  private readonly details = new Map<string, Details>()
  /** Ids whose details are being read from disk. */
  private readonly reading = new Set<string>()
  /** Ids with an install or update in flight. */
  private readonly busy = new Set<string>()
  private checking: Promise<void> | null = null
  private updateTimer: unknown = null
  private foreground = true
  /** A check the interval skipped while the app was in the background. */
  private checkDue = false

  /**
   * Shows the install prompt and resolves with the user's decision. The default is the host's
   * native confirm dialog; the chrome replaces it with its own sheet without touching the flow.
   */
  confirmInstall: ConfirmInstall = (request, win) => this.nativeConfirm(request, win)

  constructor(
    protected readonly browser: Browser,
    private readonly io: AndroidExtensionStoreIo,
    options: AndroidExtensionsOptions = {}
  ) {
    this.hooks = options.hooks ?? noRuntimeHooks
    this.chromiumVersion =
      options.chromiumVersion ??
      storeChromiumVersion(typeof navigator === 'undefined' ? '' : navigator.userAgent)
    this.locale =
      options.locale !== undefined
        ? options.locale
        : typeof navigator === 'undefined'
          ? null
          : navigator.language
    this.now = options.now ?? (() => Date.now())
    this.timers = {
      setTimeout: options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      setInterval: options.setInterval ?? ((fn, ms) => setInterval(fn, ms)),
      clearInterval:
        options.clearInterval ??
        ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
    }
    this.store = new JsonStore<ExtensionRegistry>(browser.platform.io, 'extensions.json', 300)
    this.registry = migrateRegistry(
      this.store.readSync(),
      { idForPath: idForUnpackedPath, readManifest: () => null },
      this.now()
    )
  }

  /** `files/zen/extensions`, absolute. */
  get root(): string {
    return this.io.root
  }

  async start(): Promise<void> {
    try {
      const swept = await this.io.sweep()
      if (swept.staging.length > 0 || swept.packages > 0)
        console.log(
          `[zen] extensions: swept ${swept.staging.length} staging folder(s) and ${swept.packages} package file(s)`
        )
    } catch (error) {
      console.warn('[zen] extensions: sweep failed:', (error as Error).message)
    }
    for (const record of this.registry.extensions) {
      if (record.enabled) await this.attach(record)
      void this.readDetails(record)
    }
    this.browser.state.commitVolatile()
    this.scheduleUpdateChecks()
    // A package another app handed over while the chrome was still booting.
    void this.installPending()
  }

  /** Installs the packages other apps sent to Zenium that Kotlin holds (see `takeSideloads`). */
  async installPending(win?: ZenWindow): Promise<void> {
    let handles: PackageHandle[]
    try {
      handles = await this.io.takeSideloads()
    } catch (error) {
      console.warn('[zen] extensions: could not collect sideloads:', (error as Error).message)
      return
    }
    for (const handle of handles) await this.installHandle(handle, win)
  }

  record(id: string): ExtensionRecord | undefined {
    return this.registry.extensions.find((r) => r.id === id)
  }

  records(): readonly ExtensionRecord[] {
    return this.registry.extensions
  }

  /** The runtime's load error for an extension, if its last attach failed. */
  error(id: string): string | null {
    return this.errors.get(id) ?? null
  }

  // ---------------------------------------------------------------------------
  // The runtime seam
  // ---------------------------------------------------------------------------

  private async attach(record: ExtensionRecord): Promise<void> {
    this.errors.delete(record.id)
    try {
      await this.hooks.attach(record)
      this.attached.add(record.id)
    } catch (error) {
      this.errors.set(record.id, (error as Error).message)
    }
  }

  private async detach(id: string): Promise<void> {
    if (!this.attached.has(id)) return
    this.attached.delete(id)
    try {
      await this.hooks.detach(id)
    } catch (error) {
      console.warn(`[zen] extensions: detach of ${id} failed:`, (error as Error).message)
    }
  }

  private async reconfigure(record: ExtensionRecord): Promise<void> {
    if (!this.attached.has(record.id)) return
    try {
      await this.hooks.reconfigure(record)
    } catch (error) {
      this.errors.set(record.id, (error as Error).message)
    }
  }

  // ---------------------------------------------------------------------------
  // What the chrome sees
  // ---------------------------------------------------------------------------

  list(): ExtensionInfo[] {
    return this.registry.extensions.map((record) => {
      const details = this.details.get(record.id)
      const manifest = details?.manifest ?? manifestFromRecord(record)
      const update = this.updates.get(record.id) ?? NO_UPDATE_INFO
      return {
        id: record.id,
        name: record.name || manifest.name || 'Extension',
        version: record.version,
        description: record.description || manifest.description || '',
        path: record.path,
        enabled: record.enabled,
        icon: details?.icon ?? null,
        popup: record.popup,
        error: this.errors.get(record.id) ?? null,
        source: record.source,
        publisher: record.publisher,
        updateUrl: record.updateUrl,
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
        pinned: record.pinned,
        allowFileAccess: record.allowFileAccess,
        manifestVersion: record.manifestVersion,
        permissions: record.permissions,
        hostPermissions: record.hostPermissions,
        optionsPage: record.optionsPage,
        warnings: permissionWarningLines(manifest, 'other'),
        pendingWarnings: record.pendingWarnings,
        updateState: update.state,
        availableVersion: update.availableVersion,
        updateError: update.error,
        updateCheckedAt: update.checkedAt
      }
    })
  }

  /** Reads an installed version's manifest and icon from disk; the list re-renders once they are in. */
  private async readDetails(record: ExtensionRecord): Promise<void> {
    if (this.details.has(record.id) || this.reading.has(record.id)) return
    this.reading.add(record.id)
    try {
      const raw = await this.io.readInstalledFile(record.path, 'manifest.json')
      if (!raw) return
      let manifest: Details['manifest']
      try {
        manifest = JSON.parse(
          stripJsonComments(new TextDecoder().decode(raw))
        ) as Details['manifest']
      } catch {
        return
      }
      let icon: string | null = null
      for (const rel of iconCandidates(manifest)) {
        const bytes = await this.io.readInstalledFile(record.path, rel)
        if (!bytes) continue
        icon = `data:${imageMime(rel)};base64,${base64Encode(bytes)}`
        break
      }
      // The record may have been replaced while the files were read.
      if (this.record(record.id)?.path !== record.path) return
      this.details.set(record.id, { manifest, icon })
      this.browser.state.commitVolatile()
    } catch (error) {
      console.warn(`[zen] extensions: could not read ${record.path}:`, (error as Error).message)
    } finally {
      this.reading.delete(record.id)
    }
  }

  // ---------------------------------------------------------------------------
  // Installing packages (store, .crx, .zip)
  // ---------------------------------------------------------------------------

  /** Android has no folder picker: an unpacked extension arrives as a `.zip` of its folder. */
  async addFromDialog(win: ZenWindow): Promise<void> {
    await this.installFromFileDialog(win)
  }

  async installFromFileDialog(win: ZenWindow): Promise<void> {
    const handle = await this.io.pick()
    if (!handle) return
    await this.installHandle(handle, win)
  }

  /** A package file Kotlin holds: picked in the document picker, or sent to Zenium by another app. */
  async installHandle(handle: PackageHandle, win?: ZenWindow): Promise<void> {
    const started = this.now()
    let bytes: Uint8Array | null = null
    try {
      bytes = await this.io.readHandle(handle)
      const name = packageFileName(handle.name, bytes)
      const { pkg, kind } = await packageFromFile(name, bytes, { locale: this.locale })
      console.log(
        `[zen] extensions: read ${name} as ${pkg.id} ${pkg.version} (${kind}, ${pkg.files.length} files, ${bytes.length} bytes, ${elapsed(started, this.now())})`
      )
      const outcome = await this.installPackage(
        bytes,
        pkg,
        kind === 'crx' ? parseCrxHeader(bytes).zipOffset : 0,
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
      console.warn(`[zen] extensions: could not install ${handle.name}:`, message)
      this.browser.toast(`Could not install ${handle.name}: ${message}`, 'error', win)
    } finally {
      if (bytes) this.io.release(bytes)
      else this.io.discard(handle.token)
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
    let bytes: Uint8Array | null = null
    try {
      const download = await this.downloadPackage(parsed.id, store ?? parsed.store)
      bytes = download.bytes
      const outcome = await this.installPackage(
        bytes,
        download.pkg,
        download.zipOffset,
        {
          source: download.store,
          publisher: download.pkg.publisher,
          updateUrl: STORE_UPDATE_URLS[download.store]
        },
        { confirm: true, win }
      )
      this.toastOutcome(outcome, download.pkg, win)
    } catch (error) {
      const message = (error as Error).message
      console.warn(`[zen] extensions: could not install ${parsed.id}:`, message)
      this.browser.toast(`Could not install extension: ${message}`, 'error', win)
    } finally {
      if (bytes) this.io.release(bytes)
    }
  }

  /**
   * Runs one of the core's downloads over `fetchPackage` and frees every temporary file it left
   * behind except the bytes it returned: a store that answered with a body but no package, a
   * package that failed its hash check, a chain the core gave up on.
   */
  private async download<T extends { bytes: Uint8Array }>(
    run: (fetch: StoreFetch) => Promise<T>
  ): Promise<T> {
    const fetched: Uint8Array[] = []
    const fetch: StoreFetch = async (url) => {
      const response = await this.io.fetchPackage(url)
      fetched.push(response.bytes)
      return response
    }
    let result: T | null = null
    try {
      result = await run(fetch)
      return result
    } finally {
      for (const bytes of fetched) if (bytes !== result?.bytes) this.io.release(bytes)
    }
  }

  private async downloadPackage(
    id: string,
    preferred: StoreId | null
  ): Promise<{ bytes: Uint8Array; pkg: ExtensionPackage; zipOffset: number; store: StoreId }> {
    const started = this.now()
    const download = await this.download((fetch) =>
      downloadFromStores(fetch, id, preferred, this.chromiumVersion)
    )
    const downloaded = this.now()
    try {
      const pkg = await installFromCrx(download.bytes, { expectedId: id, locale: this.locale })
      const skipped = download.skipped
        .map((s) => ` (${storeLabel(s.store)}: HTTP ${s.status})`)
        .join('')
      console.log(
        `[zen] extensions: downloaded ${id} ${pkg.version} from ${storeLabel(download.store)}${skipped}: ${download.bytes.length} bytes in ${elapsed(started, downloaded)}, verified ${pkg.publisher} signature and read ${pkg.files.length} entries in ${elapsed(downloaded, this.now())}`
      )
      return {
        bytes: download.bytes,
        pkg,
        zipOffset: parseCrxHeader(download.bytes).zipOffset,
        store: download.store
      }
    } catch (error) {
      this.io.release(download.bytes)
      throw error
    }
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
   * The one install path: confirm (unless already approved), unpack the version directory, swap
   * the registry record, hand the extension to the runtime, prune older versions. A version the
   * runtime refuses rolls back to the one that was running.
   */
  async installPackage(
    bytes: Uint8Array,
    pkg: ExtensionPackage,
    zipOffset: number,
    meta: InstallMeta,
    options: { confirm: boolean; win?: ZenWindow }
  ): Promise<InstallOutcome> {
    if (this.busy.has(pkg.id)) return { status: 'in-progress' }
    this.busy.add(pkg.id)
    try {
      const existing = this.record(pkg.id)
      const icon = await packageIcon(pkg)
      if (options.confirm) {
        const ok = await this.confirmInstall(
          {
            kind: existing ? 'update' : 'install',
            name: pkg.manifest.name,
            icon,
            warnings: permissionWarningLines(pkg.manifest, 'other'),
            source: meta.source
          },
          options.win
        )
        if (!ok) return { status: 'cancelled' }
      }
      const started = this.now()
      const dir = await this.io.unpack(bytes, pkg, zipOffset, await manifestToWrite(pkg))
      console.log(
        `[zen] extensions: unpacked ${pkg.id} ${pkg.version} (${pkg.files.length} files, ${pkg.totalSize} bytes) to ${dir} in ${elapsed(started, this.now())}`
      )
      const now = this.now()
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
      if (existing) await this.detach(existing.id)
      this.replace(record)
      this.details.set(record.id, {
        manifest: pkg.manifest as unknown as Details['manifest'],
        icon
      })
      if (record.enabled) await this.attach(record)
      const error = this.errors.get(record.id)
      if (error && existing && existing.path !== dir) {
        console.warn(
          `[zen] extensions: ${pkg.id} ${pkg.version} failed to load, keeping ${existing.version}:`,
          error
        )
        this.replace(existing)
        this.details.delete(existing.id)
        await this.io.prune(existing.id, existing.path).catch(() => [])
        if (existing.enabled) await this.attach(existing)
        void this.readDetails(existing)
        this.persist()
        this.browser.state.commitVolatile()
        throw new Error(error)
      }
      if (existing && isManagedPath(this.root, existing.path) && existing.path !== dir) {
        const pruned = await this.io.prune(record.id, dir).catch(() => [])
        if (pruned.length > 0) console.log(`[zen] extensions: pruned ${pruned.join(', ')}`)
      }
      this.persist()
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

  async remove(id: string): Promise<void> {
    const record = this.record(id) ?? this.registry.extensions.find((r) => r.path === id)
    if (!record) return
    await this.detach(record.id)
    this.registry.extensions = this.registry.extensions.filter((r) => r !== record)
    this.errors.delete(record.id)
    this.updates.delete(record.id)
    this.details.delete(record.id)
    if (isManagedPath(this.root, record.path))
      await this.io
        .remove(record.id)
        .catch((error: Error) =>
          console.warn(`[zen] extensions: could not delete ${record.path}:`, error.message)
        )
    this.persist()
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
          icon: this.details.get(record.id)?.icon ?? null,
          warnings: record.pendingWarnings,
          source: record.source
        },
        win
      )
      if (!ok) return
      record.pendingWarnings = null
    }
    record.enabled = enabled
    if (enabled) await this.attach(record)
    else await this.detach(record.id)
    this.persist()
    this.browser.state.commitVolatile()
  }

  setPinned(id: string, pinned: boolean): void {
    const record = this.record(id)
    if (!record || record.pinned === pinned) return
    record.pinned = pinned
    this.persist()
    void this.reconfigure(record)
    this.browser.state.commitVolatile()
  }

  /** Stop and start again, re-reading the installed files. */
  async reload(id: string): Promise<void> {
    const record = this.record(id)
    if (!record) return
    await this.detach(record.id)
    this.details.delete(record.id)
    if (record.enabled) await this.attach(record)
    void this.readDetails(record)
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

  /** Toolbar popups are the runtime's (`ExtensionPopup.kt`); the store has nothing to show. */
  openPopup(id: string, _anchor: Rect, win: ZenWindow): void {
    const record = this.record(id)
    if (!record) return
    this.browser.toast(`${record.name || 'This extension'} has no popup here yet.`, 'info', win)
  }

  closePopup(): void {
    // Nothing of the store's is open; the runtime closes its own popup.
  }

  // ---------------------------------------------------------------------------
  // Updates
  // ---------------------------------------------------------------------------

  private scheduleUpdateChecks(): void {
    this.timers.setTimeout(() => this.runScheduledCheck(), UPDATE_CHECK_STARTUP_DELAY_MS)
    this.updateTimer = this.timers.setInterval(
      () => this.runScheduledCheck(),
      UPDATE_CHECK_INTERVAL_MS
    )
  }

  /** The schedule fires only while the app is on screen; a missed check runs on the way back. */
  private runScheduledCheck(): void {
    if (!this.foreground) {
      this.checkDue = true
      return
    }
    this.checkDue = false
    void this.checkForUpdates()
  }

  /** The Activity paused or resumed (`pause` / `resume` host events). */
  setForeground(foreground: boolean): void {
    this.foreground = foreground
    if (foreground && this.checkDue) this.runScheduledCheck()
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
    const started = this.now()
    if (records.length === 0) {
      this.registry.lastUpdateCheck = started
      this.persist()
      if (interactive) this.browser.toast('No installed extension can be updated.', 'info', win)
      return
    }
    const results = await checkForUpdates(
      this.io.fetchText,
      records.map((r) => ({
        id: r.id,
        version: r.version,
        updateUrl: r.updateUrl,
        store: storeOf(r.source)
      })),
      { chromiumVersion: this.chromiumVersion }
    )
    const checkedAt = this.now()
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
      `[zen] extensions: checked ${records.length} extension(s) for updates in ${elapsed(started, this.now())}: ${installed} updated, ${failed} failed`
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
    const started = this.now()
    const { bytes } = await this.download(async (fetch) => ({
      bytes: await downloadUpdate(fetch, update)
    }))
    try {
      const pkg = await installFromCrx(bytes, { expectedId: record.id, locale: this.locale })
      console.log(
        `[zen] extensions: downloaded update ${record.id} ${record.version} -> ${pkg.version} (${bytes.length} bytes, sha256 ${update.sha256 ? 'verified' : 'not announced'}) in ${elapsed(started, this.now())}`
      )
      const before = permissionWarnings(await this.installedManifest(record), 'other')
      const after = permissionWarnings(pkg.manifest, 'other')
      const added = newWarnings(before, after).map((w) => w.message)
      const outcome = await this.installPackage(
        bytes,
        pkg,
        parseCrxHeader(bytes).zipOffset,
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
        await this.detach(outcome.record.id)
        this.persist()
      }
    } finally {
      this.io.release(bytes)
    }
  }

  /** The manifest the installed version was approved with: from memory, from disk, or the record. */
  private async installedManifest(record: ExtensionRecord): Promise<PermissionWarningSource> {
    const known = this.details.get(record.id)
    if (known) return known.manifest
    const raw = await this.io.readInstalledFile(record.path, 'manifest.json').catch(() => null)
    if (raw) {
      try {
        return JSON.parse(
          stripJsonComments(new TextDecoder().decode(raw))
        ) as PermissionWarningSource
      } catch {
        /* fall through to the record */
      }
    }
    return manifestFromRecord(record)
  }

  // ---------------------------------------------------------------------------
  // Install prompt
  // ---------------------------------------------------------------------------

  private nativeConfirm(request: InstallConfirmation, win?: ZenWindow): Promise<boolean> {
    const text = installPromptText(request)
    return this.browser.platform.dialogs.confirm(
      { message: text.message, detail: text.detail, okLabel: text.okLabel, cancelLabel: 'Cancel' },
      win
    )
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private persist(): void {
    this.store.write(this.registry)
  }

  flushSync(): void {
    if (this.updateTimer !== null) this.timers.clearInterval(this.updateTimer)
    this.updateTimer = null
    this.store.flushSync()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The `manifest.json` Kotlin writes instead of the archive's: the developer key for signed
 * packages (the core rewrote that entry), a synthetic key for unsigned zips.
 */
async function manifestToWrite(pkg: ExtensionPackage): Promise<Uint8Array | null> {
  const override = zipManifestOverride(pkg)
  if (override) return override
  if (!pkg.signed) return null
  const entry = pkg.files.find((f) => f.path === 'manifest.json')
  return entry ? entry.bytes() : null
}

/** The warning-relevant manifest keys as the record remembers them. */
function manifestFromRecord(record: ExtensionRecord): Details['manifest'] {
  return {
    manifest_version: record.manifestVersion,
    permissions: record.permissions,
    host_permissions: record.hostPermissions,
    name: record.name,
    description: record.description
  }
}

function storeOf(source: ExtensionSource): StoreId | null {
  return source === 'chrome-web-store' || source === 'edge-add-ons' ? source : null
}

function describe(result: UpdateCheckResult): string {
  if (result.status === 'update-available')
    return `${result.version} available (${result.size ?? '?'} bytes, sha256 ${result.sha256 ?? 'none'}) at ${result.codebase}`
  if (result.status === 'up-to-date') return 'up to date'
  return `error (${result.reason})`
}

function elapsed(from: number, to: number): string {
  return `${to - from} ms`
}
