/**
 * `chrome.sidePanel`, the pure part: Chrome's option shapes, argument checks, and the per-extension
 * option state that decides which page (if any) the panel shows for a tab. Chrome keeps one set
 * of default options (seeded from the manifest's `side_panel.default_path`) and any number of
 * tab-specific sets; a tab's effective options are the tab-specific fields laid over the default
 * ones, and the panel shows for the tab when that leaves `enabled` true and a `path`.
 *
 * The host module owns the panel view itself (`main/platform/extensionApi/sidePanel.ts`).
 */

export interface PanelOptions {
  tabId?: number
  path?: string
  enabled?: boolean
}

export interface PanelBehavior {
  openPanelOnActionClick: boolean
}

export interface OpenPanelOptions {
  windowId?: number
  tabId?: number
}

/** What the panel shows for one tab once the options are resolved. */
export interface EffectivePanel {
  /** Extension-relative page, or null when the panel is off for the tab. */
  path: string | null
  /** True when the options that produced this came from a tab-specific set. */
  tabScoped: boolean
}

/** `onOpened` / `onClosed`: the page shown, its window, and the tab for a tab-specific panel. */
export interface PanelOpenedInfo {
  path: string
  windowId: number
  tabId?: number
}

export type PanelClosedInfo = PanelOpenedInfo

/** `getLayout()`: which side of the window the panel docks on. */
export interface PanelLayout {
  side: 'left' | 'right'
}

export const SIDE_PANEL_SIDES = { LEFT: 'left', RIGHT: 'right' } as const

export const ERROR_NO_PERMISSION = "The extension does not have the 'sidePanel' permission."
export const ERROR_NO_TARGET = 'At least one of `windowId` or `tabId` must be specified.'
export const ERROR_NO_ACTIVE_WINDOW = 'No active browser window.'
export const ERROR_INVALID_OPTIONS = 'Invalid options'
export const ERROR_INVALID_BEHAVIOR = 'Invalid behavior'

export class SidePanelError extends Error {}

export function noTab(tabId: number): string {
  return `No tab with id: ${tabId}.`
}

export function noWindow(windowId: number): string {
  return `No window with id: ${windowId}.`
}

export function noPanelForTab(tabId: number): string {
  return `No active side panel for tabId: ${tabId}`
}

export function noPanelForWindow(windowId: number): string {
  return `No active side panel for windowId: ${windowId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/** Extension-relative paths lose their leading slashes; anything else is rejected. */
function checkPath(value: unknown): string {
  if (typeof value !== 'string') throw new SidePanelError(ERROR_INVALID_OPTIONS)
  const path = value.replace(/^\/+/, '')
  if (path.length === 0 || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new SidePanelError(ERROR_INVALID_OPTIONS)
  }
  return path
}

export function normalizePanelOptions(raw: unknown): PanelOptions {
  if (!isRecord(raw)) throw new SidePanelError(ERROR_INVALID_OPTIONS)
  const options: PanelOptions = {}
  if (raw.tabId !== undefined) {
    if (!isInteger(raw.tabId) || raw.tabId < 0) throw new SidePanelError(ERROR_INVALID_OPTIONS)
    options.tabId = raw.tabId
  }
  if (raw.path !== undefined) options.path = checkPath(raw.path)
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new SidePanelError(ERROR_INVALID_OPTIONS)
    options.enabled = raw.enabled
  }
  return options
}

/** `getOptions(options)`: the tab asked about, or undefined for the default options. */
export function normalizeGetOptions(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) throw new SidePanelError(ERROR_INVALID_OPTIONS)
  if (raw.tabId === undefined) return undefined
  if (!isInteger(raw.tabId) || raw.tabId < 0) throw new SidePanelError(ERROR_INVALID_OPTIONS)
  return raw.tabId
}

export function normalizePanelBehavior(raw: unknown): Partial<PanelBehavior> {
  if (!isRecord(raw)) throw new SidePanelError(ERROR_INVALID_BEHAVIOR)
  if (raw.openPanelOnActionClick === undefined) return {}
  if (typeof raw.openPanelOnActionClick !== 'boolean') {
    throw new SidePanelError(ERROR_INVALID_BEHAVIOR)
  }
  return { openPanelOnActionClick: raw.openPanelOnActionClick }
}

export function normalizeOpenOptions(raw: unknown): OpenPanelOptions {
  if (!isRecord(raw)) throw new SidePanelError(ERROR_NO_TARGET)
  const options: OpenPanelOptions = {}
  if (raw.windowId !== undefined) {
    if (!isInteger(raw.windowId)) throw new SidePanelError(ERROR_INVALID_OPTIONS)
    options.windowId = raw.windowId
  }
  if (raw.tabId !== undefined) {
    if (!isInteger(raw.tabId) || raw.tabId < 0) throw new SidePanelError(ERROR_INVALID_OPTIONS)
    options.tabId = raw.tabId
  }
  if (options.windowId === undefined && options.tabId === undefined) {
    throw new SidePanelError(ERROR_NO_TARGET)
  }
  return options
}

/** `close(options)` takes the same `tabId` / `windowId` pair as `open`, at least one of them. */
export const normalizeCloseOptions = normalizeOpenOptions

/** The manifest's `side_panel.default_path`, cleaned the way `setOptions` cleans paths. */
export function manifestPanelPath(manifest: unknown): string | null {
  if (!isRecord(manifest) || !isRecord(manifest.side_panel)) return null
  const raw = manifest.side_panel.default_path
  if (typeof raw !== 'string') return null
  const path = raw.replace(/^\/+/, '')
  return path.length > 0 ? path : null
}

/**
 * One extension's side-panel options: Chrome's default set plus tab-specific sets, with the
 * merge rules of `setOptions` (fields given replace, fields left out stay) and the resolution
 * of `getOptions` (the tab's own set when it has one, else the default, else the manifest).
 */
export class SidePanelOptions {
  private defaults: PanelOptions | null = null
  private readonly perTab = new Map<number, PanelOptions>()
  behavior: PanelBehavior = { openPanelOnActionClick: false }

  constructor(readonly manifestPath: string | null) {}

  private fromManifest(): PanelOptions {
    return this.manifestPath ? { path: this.manifestPath, enabled: true } : {}
  }

  setOptions(options: PanelOptions): void {
    if (options.tabId === undefined) {
      const current = this.defaults ?? this.fromManifest()
      this.defaults = { ...current, ...withoutTabId(options) }
      return
    }
    const current = this.perTab.get(options.tabId) ?? {}
    this.perTab.set(options.tabId, { ...current, ...withoutTabId(options), tabId: options.tabId })
  }

  getOptions(tabId: number | undefined): PanelOptions {
    if (tabId !== undefined) {
      const own = this.perTab.get(tabId)
      if (own) return { ...own }
    }
    return { ...(this.defaults ?? this.fromManifest()) }
  }

  /** What the panel shows for `tabId`: the tab's fields over the defaults over the manifest. */
  effective(tabId: number | undefined): EffectivePanel {
    const own = tabId === undefined ? undefined : this.perTab.get(tabId)
    const merged: PanelOptions = { ...this.fromManifest(), ...this.defaults, ...own }
    const path = merged.enabled !== false && merged.path ? merged.path : null
    return { path, tabScoped: own !== undefined }
  }

  /** The extension has a global panel (one that shows on tabs without their own options). */
  hasDefaultPanel(): boolean {
    const merged: PanelOptions = { ...this.fromManifest(), ...this.defaults }
    return merged.enabled !== false && Boolean(merged.path)
  }

  setBehavior(patch: Partial<PanelBehavior>): void {
    this.behavior = { ...this.behavior, ...patch }
  }

  /** A tab closed: its options go with it. */
  tabRemoved(tabId: number): void {
    this.perTab.delete(tabId)
  }
}

function withoutTabId(options: PanelOptions): Omit<PanelOptions, 'tabId'> {
  const rest: Omit<PanelOptions, 'tabId'> = {}
  if (options.path !== undefined) rest.path = options.path
  if (options.enabled !== undefined) rest.enabled = options.enabled
  return rest
}
