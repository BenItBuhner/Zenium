import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { ExtensionActionState } from '../../../shared/types'
import type { ZenWindow } from '../../../core/window'
import type { ExtensionManifest } from '../../../core/extensions/manifest'
import {
  ApiError,
  extensionUrl,
  isInteger,
  isRecord,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

type ColorArray = [number, number, number, number]

interface ActionValues {
  badgeText: string
  badgeBackgroundColor: ColorArray | null
  badgeTextColor: ColorArray | null
  title: string
  /** PNG / SVG data URL, or null for the manifest's icon. */
  icon: string | null
  /** Extension-relative popup path; empty for "no popup" (`onClicked` fires instead). */
  popup: string
  enabled: boolean
}

interface ActionRecord {
  /** What the manifest declares; a global value set to null falls back to it. */
  defaults: ActionValues
  global: ActionValues
  perTab: Map<number, Partial<ActionValues>>
}

const DEFAULT_BADGE_BACKGROUND: ColorArray = [0, 0, 0, 0]
const PREFERRED_ICON_SIZE = 32

/**
 * `chrome.action` (MV3) and `chrome.browserAction` (MV2): the per-extension, per-tab toolbar
 * state Electron's bindings accept but never retain, plus `onClicked` for extensions without a
 * popup. The effective state for the active tab is exposed to the UI through `ExtensionInfo`.
 */
export class ActionApi {
  private readonly records = new Map<string, ActionRecord>()

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    setTitle: (ctx, d) => this.set(ctx, d, 'title', (v) => (typeof v === 'string' ? v : null)),
    getTitle: (ctx, d) => this.get(ctx, d, 'title'),
    setIcon: (ctx, d) => this.setIcon(ctx, d),
    setPopup: (ctx, d) => this.setPopup(ctx, d),
    getPopup: (ctx, d) => this.getPopup(ctx, d),
    setBadgeText: (ctx, d) =>
      this.set(ctx, d, 'badgeText', (v) => (typeof v === 'string' ? v : null), 'text'),
    getBadgeText: (ctx, d) => this.get(ctx, d, 'badgeText'),
    setBadgeBackgroundColor: (ctx, d) =>
      this.set(ctx, d, 'badgeBackgroundColor', parseColor, 'color'),
    getBadgeBackgroundColor: (ctx, d) =>
      this.get(ctx, d, 'badgeBackgroundColor') ?? DEFAULT_BADGE_BACKGROUND,
    setBadgeTextColor: (ctx, d) => this.set(ctx, d, 'badgeTextColor', parseColor, 'color'),
    getBadgeTextColor: (ctx, d) => this.get(ctx, d, 'badgeTextColor') ?? [255, 255, 255, 255],
    enable: (ctx, tabId) => this.setEnabled(ctx, tabId, true),
    disable: (ctx, tabId) => this.setEnabled(ctx, tabId, false),
    isEnabled: (ctx, tabId) => this.isEnabled(ctx, tabId),
    getUserSettings: () => ({ isOnToolbar: true }),
    openPopup: (ctx, options) => this.openPopup(ctx, options)
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  private record(ext: LoadedExtension): ActionRecord {
    let record = this.records.get(ext.id)
    if (!record) {
      const action = actionOf(ext.manifest)
      const defaults: ActionValues = {
        badgeText: '',
        badgeBackgroundColor: null,
        badgeTextColor: null,
        title: action?.default_title ?? ext.manifest.name ?? '',
        icon: null,
        popup: (action?.default_popup ?? '').replace(/^\/+/, ''),
        enabled: true
      }
      record = { defaults, global: { ...defaults }, perTab: new Map() }
      this.records.set(ext.id, record)
    }
    return record
  }

  private effective(ext: LoadedExtension, tabId: number | undefined): ActionValues {
    const record = this.record(ext)
    const tab = tabId === undefined ? undefined : record.perTab.get(tabId)
    return tab ? { ...record.global, ...tab } : record.global
  }

  private tabIdOf(details: unknown): number | undefined {
    if (!isRecord(details) || details.tabId === undefined || details.tabId === null)
      return undefined
    if (!isInteger(details.tabId)) throw new ApiError('Invalid tab id')
    if (!this.host.model.zenTab(details.tabId) && !this.host.model.popupForTabId(details.tabId)) {
      throw new ApiError(`No tab with id: ${details.tabId}.`)
    }
    return details.tabId
  }

  private write<K extends keyof ActionValues>(
    ext: LoadedExtension,
    tabId: number | undefined,
    key: K,
    value: ActionValues[K] | null
  ): void {
    const record = this.record(ext)
    if (tabId === undefined) {
      record.global[key] = value === null ? record.defaults[key] : value
    } else {
      const tab = record.perTab.get(tabId) ?? {}
      if (value === null) delete tab[key]
      else tab[key] = value
      if (Object.keys(tab).length === 0) record.perTab.delete(tabId)
      else record.perTab.set(tabId, tab)
    }
    this.host.commitUi()
  }

  private set<K extends keyof ActionValues>(
    ctx: ApiContext,
    details: unknown,
    key: K,
    parse: (raw: unknown) => ActionValues[K] | null,
    field: string = key
  ): void {
    if (!isRecord(details)) throw new ApiError('Invalid details')
    const tabId = this.tabIdOf(details)
    const raw = details[field]
    if (raw === undefined || raw === null) {
      this.write(ctx.extension, tabId, key, null)
      return
    }
    const value = parse(raw)
    if (value === null) throw new ApiError(`Invalid value for ${field}.`)
    this.write(ctx.extension, tabId, key, value)
  }

  private get<K extends keyof ActionValues>(
    ctx: ApiContext,
    details: unknown,
    key: K
  ): ActionValues[K] {
    return this.effective(ctx.extension, this.tabIdOf(details))[key]
  }

  private setIcon(ctx: ApiContext, details: unknown): void {
    if (!isRecord(details)) throw new ApiError('Invalid details')
    const tabId = this.tabIdOf(details)
    let icon: string | null = null
    if (details.imageData !== undefined && details.imageData !== null) {
      icon = iconFromImageData(details.imageData)
      if (!icon) throw new ApiError('Invalid imageData.')
    } else if (details.path !== undefined && details.path !== null) {
      icon = iconFromPaths(ctx.extension.path, details.path)
      if (!icon) throw new ApiError('Could not load action icon.')
    } else {
      throw new ApiError('Either the path or imageData property must be specified.')
    }
    this.write(ctx.extension, tabId, 'icon', icon)
  }

  private setPopup(ctx: ApiContext, details: unknown): void {
    if (!isRecord(details) || typeof details.popup !== 'string') {
      throw new ApiError('Invalid value for popup.')
    }
    const tabId = this.tabIdOf(details)
    // Chrome treats an absolute extension URL and a relative path alike.
    const own = `chrome-extension://${ctx.extensionId}/`
    const popup = details.popup.startsWith(own)
      ? details.popup.slice(own.length)
      : details.popup.replace(/^\/+/, '')
    this.write(ctx.extension, tabId, 'popup', popup)
  }

  private getPopup(ctx: ApiContext, details: unknown): string {
    const popup = this.effective(ctx.extension, this.tabIdOf(details)).popup
    return popup ? extensionUrl(ctx.extensionId, popup) : ''
  }

  private setEnabled(ctx: ApiContext, tabId: unknown, enabled: boolean): void {
    const id = this.tabIdOf({ tabId })
    this.write(ctx.extension, id, 'enabled', enabled)
  }

  private isEnabled(ctx: ApiContext, tabId: unknown): boolean {
    return this.effective(ctx.extension, this.tabIdOf({ tabId })).enabled
  }

  private openPopup(ctx: ApiContext, options: unknown): void {
    let win: ZenWindow | undefined
    if (isRecord(options) && isInteger(options.windowId)) {
      win = this.host.model.zenWindow(options.windowId)
      if (!win) throw new ApiError(`No window with id: ${options.windowId}.`)
    } else {
      win = ctx.window ?? this.host.model.lastFocusedWindow()
    }
    if (!win) throw new ApiError('No window to open the popup in.')
    const active = this.host.browser.tabs.activeTabFor(win)
    const tabId = active ? this.host.model.chromeTabId(active) : undefined
    const values = this.effective(ctx.extension, tabId)
    if (!values.popup) throw new ApiError('Extension has no popup on the active tab.')
    if (!values.enabled) throw new ApiError('Extension is disabled on the active tab.')
    this.host.openPopup(ctx.extensionId, win)
  }

  // ---------------------------------------------------------------------------
  // Browser-side hooks
  // ---------------------------------------------------------------------------

  /** What a toolbar click in `win` does: open `popup`, or fire `onClicked` when it is empty. */
  clickState(extensionId: string, win: ZenWindow): { popup: string; enabled: boolean } {
    const ext = this.host.loaded(extensionId)
    if (!ext) return { popup: '', enabled: false }
    const active = this.host.browser.tabs.activeTabFor(win)
    const values = this.effective(ext, active ? this.host.model.chromeTabId(active) : undefined)
    return { popup: values.popup, enabled: values.enabled }
  }

  /** The toolbar button was pressed and the extension has no popup: `onClicked(tab)`. */
  clicked(extensionId: string, win: ZenWindow): void {
    const ext = this.host.loaded(extensionId)
    if (!ext) return
    const active = this.host.browser.tabs.activeTabFor(win)
    if (!active) return
    const tab = this.host.model.chromeTab(active, this.host.canSeeTab(ext, active.url))
    this.host.dispatch(extensionId, 'action', 'onClicked', [tab], { wake: true })
  }

  /** The state the toolbar should show for an extension right now (its active tab). */
  stateFor(extensionId: string): ExtensionActionState | null {
    const ext = this.host.loaded(extensionId)
    if (!ext) return null
    const win = this.host.model.lastFocusedWindow()
    const active = win ? this.host.browser.tabs.activeTabFor(win) : undefined
    const values = this.effective(ext, active ? this.host.model.chromeTabId(active) : undefined)
    return {
      badgeText: values.badgeText,
      badgeBackgroundColor: values.badgeBackgroundColor
        ? cssColor(values.badgeBackgroundColor)
        : null,
      badgeTextColor: values.badgeTextColor ? cssColor(values.badgeTextColor) : null,
      title: values.title,
      icon: values.icon,
      popup: values.popup ? extensionUrl(extensionId, values.popup) : null,
      enabled: values.enabled
    }
  }

  tabRemoved(tabId: number): void {
    let changed = false
    for (const record of this.records.values()) changed = record.perTab.delete(tabId) || changed
    if (changed) this.host.commitUi()
  }

  forget(extensionId: string): void {
    this.records.delete(extensionId)
  }
}

function actionOf(manifest: ExtensionManifest): ExtensionManifest['action'] {
  return manifest.action ?? manifest.browser_action ?? manifest.page_action
}

/** Chrome accepts `[r, g, b, a]` arrays and CSS colours (`#rgb`, `#rrggbb`, `rgb()`, `rgba()`). */
export function parseColor(raw: unknown): ColorArray | null {
  if (Array.isArray(raw)) {
    if (raw.length < 3 || raw.length > 4 || raw.some((n) => !isInteger(n) || n < 0 || n > 255))
      return null
    return [raw[0], raw[1], raw[2], raw.length === 4 ? raw[3] : 255]
  }
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  let m = /^#([0-9a-f]{3,4})$/i.exec(text)
  if (m) {
    const digits = m[1].split('').map((c) => parseInt(c + c, 16))
    return [digits[0], digits[1], digits[2], digits[3] ?? 255]
  }
  m = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)
  if (m) {
    const hex = m[1]
    const at = (i: number): number => parseInt(hex.slice(i, i + 2), 16)
    return [at(0), at(2), at(4), hex.length === 8 ? at(6) : 255]
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text)
  if (m) {
    const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
    const alpha = m[4] === undefined ? 255 : clamp(Number(m[4]) * 255)
    return [clamp(Number(m[1])), clamp(Number(m[2])), clamp(Number(m[3])), alpha]
  }
  return null
}

function cssColor([r, g, b, a]: ColorArray): string {
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** Pick the size closest to the toolbar's from a `{ size: path }` dictionary (or a single path). */
export function pickIconSize<T>(candidates: Record<string, T>): T | null {
  const keys = Object.keys(candidates)
  if (keys.length === 0) return null
  const sizes = keys.map(Number).filter((n) => Number.isFinite(n))
  if (sizes.length === 0) return candidates[keys[0]]
  const atLeast = sizes.filter((s) => s >= PREFERRED_ICON_SIZE).sort((a, b) => a - b)[0]
  const pick = atLeast ?? sizes.sort((a, b) => b - a)[0]
  return candidates[String(pick)]
}

function iconFromPaths(root: string, raw: unknown): string | null {
  const path = typeof raw === 'string' ? raw : isRecord(raw) ? pickIconSize(raw) : null
  if (typeof path !== 'string') return null
  try {
    const file = join(root, path.replace(/^\/+/, ''))
    const mime = IMAGE_MIME[extname(file).toLowerCase()] ?? 'image/png'
    return `data:${mime};base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}

function iconFromImageData(raw: unknown): string | null {
  if (!isRecord(raw)) return null
  const image = 'data' in raw && 'width' in raw ? raw : pickIconSize(raw)
  if (!isRecord(image)) return null
  const { width, height, data } = image
  if (!isInteger(width) || !isInteger(height) || width <= 0 || height <= 0) return null
  const bytes = toBytes(data)
  if (!bytes || bytes.length < width * height * 4) return null
  return `data:image/png;base64,${encodePng(width, height, bytes).toString('base64')}`
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (isRecord(data)) {
    // A structured clone of a typed array may arrive as an index → byte object.
    const keys = Object.keys(data)
    const out = new Uint8Array(keys.length)
    for (const key of keys) {
      const value = data[key]
      if (!isInteger(Number(key)) || typeof value !== 'number') return null
      out[Number(key)] = value
    }
    return out
  }
  return null
}

/** A minimal PNG encoder for RGBA pixels (ImageData cannot cross process boundaries). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

let crcTable: Uint32Array | null = null

function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
