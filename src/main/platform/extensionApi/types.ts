import type { Extension, ServiceWorkerMain, Session, WebContents, WebFrameMain } from 'electron'
import type { Browser } from '../../../core/browser'
import type { ZenWindow } from '../../../core/window'
import type { ExtensionManifest } from '../../../core/extensions/manifest'
import type { PermissionSet } from '../../../core/extensions/api/permissions'
import type { SessionManager } from '../sessions'
import type { ApiModel } from './model'
import type { ContextRegistry, DispatchOptions } from './contexts'
import type { ApiStore } from './store'

/** Who made an API call: a document of the extension, or its MV3 service worker. */
export type Sender =
  | { kind: 'frame'; frame: WebFrameMain; webContents: WebContents }
  | { kind: 'worker'; worker: ServiceWorkerMain; session: Session }

/** An extension the engine has loaded, with the sessions (container partitions) holding it. */
export interface LoadedExtension {
  id: string
  /** The engine's record in the primary session. */
  extension: Extension
  manifest: ExtensionManifest
  path: string
  /** Sessions the extension is loaded into, primary (default container) first. */
  sessions: Session[]
  /** Developer-mode extensions escape Chrome's 30-second alarm floor. */
  unpacked: boolean
}

/**
 * Everything a namespace handler may need about the caller. The extension id is derived in the
 * router from the frame URL or worker scope, never from the message itself.
 */
export interface ApiContext {
  extensionId: string
  extension: LoadedExtension
  session: Session
  sender: Sender
  /** The Zenium tab whose page made the call (an extension page opened as a tab), if any. */
  tabId: string | null
  /** The window the call belongs to: the popup's anchor, the tab's window, else nothing. */
  window: ZenWindow | undefined
}

export type ApiHandler = (ctx: ApiContext, ...args: unknown[]) => unknown

export type NamespaceHandlers = Record<string, ApiHandler>

/** A failure reported to the extension through `runtime.lastError` / a rejected promise. */
export class ApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

/** What the namespace modules see of the router. */
export interface ApiHost {
  readonly browser: Browser
  readonly model: ApiModel
  readonly registry: ContextRegistry
  readonly sessions: SessionManager
  readonly store: ApiStore
  loaded(extensionId: string): LoadedExtension | undefined
  allLoaded(): LoadedExtension[]
  /** Fan `namespace.event` out to every context of one extension. */
  dispatch(
    extensionId: string,
    namespace: string,
    event: string,
    args: unknown[],
    options?: DispatchOptions
  ): void
  /** Fan an event out to every loaded extension; `argsFor` may tailor (or skip) per extension. */
  broadcast(
    namespace: string,
    event: string,
    argsFor: (extension: LoadedExtension) => unknown[] | null
  ): void
  /** Whether the extension may see a tab's URL, title and favicon (`tabs` or a host permission). */
  canSeeTab(extension: LoadedExtension, url: string): boolean
  /** Whether the extension has host access to `url`: a granted host permission or `activeTab`. */
  hostAccess(extensionId: string, url: string): boolean
  /**
   * The session partitions (container ids) the extension's request rules and listeners apply
   * to: the sessions it is loaded into, plus the private partition when the user allowed it
   * there (`ExtensionInfo.allowPrivate`). Empty for an extension that is not loaded.
   */
  partitionsOf(extensionId: string): readonly string[]
  /** The extension's currently granted permissions. */
  grants(extensionId: string): PermissionSet
  /** Ask the renderer to re-render (extension state shown in the UI changed). */
  commitUi(): void
  /** Run the tab / window event differ soon (something changed outside a state commit). */
  scheduleTick(): void
  /** Open the toolbar popup of an extension in a window (the browser positions it). */
  openPopup(extensionId: string, win: ZenWindow): void
  /** A user-facing yes/no question through the platform's native dialog. */
  confirm(
    options: { message: string; detail?: string; okLabel: string; danger?: boolean },
    win?: ZenWindow
  ): Promise<boolean>
}

/**
 * Run one of the core's binding-style validators: the `TypeError` Chrome's binding would throw at
 * the caller becomes the call's error (a rejection / `runtime.lastError` on this side of the IPC).
 */
export function validated<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(error instanceof Error ? error.message : String(error))
  }
}

/** Chrome's `windows.WINDOW_ID_CURRENT` and `WINDOW_ID_NONE`. */
export const WINDOW_ID_NONE = -1
export const WINDOW_ID_CURRENT = -2
export const TAB_ID_NONE = -1

export function extensionIdFromUrl(url: string): string | null {
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(url)
  return match ? match[1] : null
}

/**
 * The extension a frame belongs to. Sub-frames an extension page creates as `about:blank` or
 * `srcdoc` have no extension URL of their own but inherit the origin, and Chrome gives them the
 * API too; the origin settles those.
 */
export function extensionIdOfFrame(frame: WebFrameMain): string | null {
  const fromUrl = extensionIdFromUrl(frame.url)
  if (fromUrl) return fromUrl
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(frame.origin)
  return match ? match[1] : null
}

export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Resolve an extension-relative path (`popup.html`, `/options.html`) to its full URL. */
export function extensionUrl(extensionId: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path
  return `chrome-extension://${extensionId}/${path.replace(/^\/+/, '')}`
}
