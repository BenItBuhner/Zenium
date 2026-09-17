import {
  app,
  ipcMain,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
  type WebFrameMain
} from 'electron'
import { join } from 'node:path'
import type { ZenWindow } from '../../core/window'
import type { ExtensionRecord } from '../../core/extensions/registry'
import {
  EMPTY_REFERRER_CHAIN,
  WEBSTORE_CHANNEL,
  WEBSTORE_EVENT_CHANNEL,
  WEBSTORE_URL_PATTERNS,
  installStatusFor,
  isWebstorePage,
  managementInfoFor,
  parseBeginInstallDetails,
  withChromeClientHints,
  type ManagementEvent,
  type ManagementMember,
  type WebstoreMv2DeprecationStatus,
  type WebstorePrivateMember,
  type WebstorePromotionType,
  type WebstoreReply,
  type WebstoreWebGlStatus
} from '../../core/extensions/webstorePrivate'
import { readManifest, type ExtensionService, type RegistryEvent } from './extensions'

const WEBSTORE_PRELOAD_ID = 'zenium-webstore'
const webstorePreload = join(__dirname, '../preload/webstore.js')

const UNINSTALL_CANCELLED_ERROR = 'The user did not accept the uninstall.'

/** Request headers for the store's servers, with Chrome's brand in the client hints. */
export function rewriteStoreRequestHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return withChromeClientHints(headers, process.versions.chrome)
}

type Handler = (args: unknown[], context: CallContext) => Promise<WebstoreReply> | WebstoreReply

interface CallContext {
  win: ZenWindow | undefined
}

/**
 * Answers the Chrome Web Store page's `chrome.webstorePrivate` and `chrome.management` calls
 * (the `preload/webstore.ts` frame preload puts them on the page) so the store's own install
 * button installs through `ExtensionService`, and forwards registry changes to open store pages
 * as `chrome.management` events. Only frames on the store's origins are answered.
 */
export class WebstoreBridge {
  /** Store pages that have talked to us; they get `chrome.management` events. */
  private readonly pages = new Set<WebContents>()
  private readonly handlers: Record<
    `webstorePrivate.${WebstorePrivateMember}` | `management.${ManagementMember}`,
    Handler
  >

  constructor(
    private readonly extensions: ExtensionService,
    /** The window a page belongs to, for anchoring prompts. */
    private readonly windowFor: (wc: WebContents) => ZenWindow | undefined
  ) {
    this.handlers = {
      'webstorePrivate.beginInstallWithManifest3': async ([details], { win }) => {
        const parsed = parseBeginInstallDetails(details)
        if (!parsed) return { value: 'invalid_id', error: 'Invalid extension id' }
        const outcome = await this.extensions.webstoreBeginInstall(parsed, win)
        return outcome.result === ''
          ? { value: '' }
          : { value: outcome.result, error: outcome.message }
      },
      'webstorePrivate.completeInstall': ([id], { win }) => this.completeInstall(id, win),
      'webstorePrivate.install': ([id], { win }) => this.completeInstall(id, win),
      'webstorePrivate.enableAppLauncher': () => ({}),
      'webstorePrivate.getBrowserLogin': () => ({ value: { login: '' } }),
      'webstorePrivate.getStoreLogin': () => ({ value: '' }),
      'webstorePrivate.setStoreLogin': () => ({}),
      'webstorePrivate.getWebGLStatus': async () => ({ value: await webGlStatus() }),
      'webstorePrivate.getIsLauncherEnabled': () => ({ value: false }),
      'webstorePrivate.isInIncognitoMode': () => ({ value: false }),
      'webstorePrivate.isPendingCustodianApproval': () => ({ value: false }),
      'webstorePrivate.getReferrerChain': () => ({ value: EMPTY_REFERRER_CHAIN }),
      'webstorePrivate.getExtensionStatus': ([id]) => ({
        value: installStatusFor(typeof id === 'string' ? this.extensions.record(id) : null)
      }),
      'webstorePrivate.getFullChromeVersion': () => ({
        value: { version_number: process.versions.chrome }
      }),
      // Electron still loads Manifest V2, so the page shows no deprecation banner.
      'webstorePrivate.getMV2DeprecationStatus': () => ({
        value: 'inactive' satisfies WebstoreMv2DeprecationStatus
      }),
      'webstorePrivate.shouldShowEnterprisePromotionBanner': () => ({
        value: 'PROMOTION_TYPE_UNSPECIFIED' satisfies WebstorePromotionType
      }),
      'webstorePrivate.logEnterprisePromoShown': () => ({}),
      'webstorePrivate.onEnterprisePromoClick': () => ({}),
      'management.getAll': () => ({
        value: this.extensions.records().map((record) => this.info(record))
      }),
      'management.get': ([id]) => {
        const record = typeof id === 'string' ? this.extensions.record(id) : undefined
        return record
          ? { value: this.info(record) }
          : { error: `Failed to find extension with id ${String(id)}.` }
      },
      'management.setEnabled': async ([id, enabled], { win }) => {
        if (typeof id !== 'string' || !this.extensions.record(id))
          return { error: `Failed to find extension with id ${String(id)}.` }
        await this.extensions.setEnabled(id, enabled === true, win)
        return {}
      },
      'management.uninstall': async ([id], { win }) => {
        const record = typeof id === 'string' ? this.extensions.record(id) : undefined
        if (!record) return { error: `Failed to find extension with id ${String(id)}.` }
        const ok = await this.extensions.confirmUninstall(record, win)
        if (!ok) return { error: UNINSTALL_CANCELLED_ERROR }
        await this.extensions.remove(record.id)
        return {}
      }
    }
  }

  /** Registers the IPC handler and starts forwarding registry events; call once. */
  install(): void {
    ipcMain.handle(WEBSTORE_CHANNEL, (event, member: unknown, args: unknown) =>
      this.handle(event, member, args)
    )
    this.extensions.onChange((event) => this.forward(event))
  }

  /**
   * Gives a persistent session's pages the store preload, and presents the session to the
   * store's servers as Chrome: the page request's client hints decide whether the store renders
   * its install button or "Switch to Chrome". Electron keeps one `onBeforeSendHeaders` listener
   * per session, so a layer that needs its own must call `rewriteStoreRequestHeaders` from it.
   */
  attach(ses: Session): void {
    if (ses.getPreloadScripts().some((script) => script.id === WEBSTORE_PRELOAD_ID)) return
    ses.registerPreloadScript({ type: 'frame', id: WEBSTORE_PRELOAD_ID, filePath: webstorePreload })
    ses.webRequest.onBeforeSendHeaders({ urls: WEBSTORE_URL_PATTERNS }, (details, callback) => {
      callback({ requestHeaders: rewriteStoreRequestHeaders(details.requestHeaders) })
    })
  }

  private async handle(
    event: IpcMainInvokeEvent,
    member: unknown,
    args: unknown
  ): Promise<WebstoreReply> {
    const frame = event.senderFrame
    if (!frame || frame.isDestroyed() || !isStoreFrame(frame))
      throw new Error('chrome.webstorePrivate is only available to the Chrome Web Store')
    const handler =
      typeof member === 'string' ? this.handlers[member as keyof typeof this.handlers] : undefined
    if (!handler) throw new Error(`Unknown member ${String(member)}`)
    this.remember(event.sender)
    const started = Date.now()
    try {
      const reply = await handler(Array.isArray(args) ? args : [], {
        win: this.windowFor(event.sender)
      })
      console.log(
        `[zen] webstore: ${member}(${summarize(args)}) -> ${summarize(reply.value)}${reply.error ? ` error "${reply.error}"` : ''} (${Date.now() - started} ms)`
      )
      return reply
    } catch (error) {
      const message = (error as Error).message
      console.warn(`[zen] webstore: ${member} failed:`, message)
      return { error: message }
    }
  }

  private async completeInstall(id: unknown, win: ZenWindow | undefined): Promise<WebstoreReply> {
    if (typeof id !== 'string') return { error: 'Invalid extension id' }
    const { error } = await this.extensions.webstoreCompleteInstall(id, win)
    return error ? { error } : {}
  }

  private info(record: ExtensionRecord): ReturnType<typeof managementInfoFor> {
    const icons = Object.entries(readManifest(record.path)?.icons ?? {})
      .map(([size, path]) => ({
        size: Number(size),
        url: `chrome-extension://${record.id}/${path.replace(/^\/+/, '')}`
      }))
      .filter((icon) => Number.isFinite(icon.size))
    return managementInfoFor(record, icons)
  }

  private remember(wc: WebContents): void {
    if (this.pages.has(wc)) return
    this.pages.add(wc)
    wc.once('destroyed', () => this.pages.delete(wc))
  }

  private forward(event: RegistryEvent): void {
    if (this.pages.size === 0) return
    const record = this.extensions.record(event.id)
    let name: ManagementEvent
    let payload: unknown
    switch (event.type) {
      case 'installed':
      case 'updated':
        if (!record) return
        name = 'onInstalled'
        payload = this.info(record)
        break
      case 'uninstalled':
        name = 'onUninstalled'
        payload = event.id
        break
      case 'enabled':
      case 'disabled':
        if (!record) return
        name = event.type === 'enabled' ? 'onEnabled' : 'onDisabled'
        payload = this.info(record)
        break
    }
    for (const wc of this.pages) {
      if (wc.isDestroyed()) {
        this.pages.delete(wc)
        continue
      }
      if (isWebstorePage(wc.getURL())) wc.send(WEBSTORE_EVENT_CHANNEL, name, payload)
    }
  }
}

/** A store page's frame, or a blank child frame of one (the preload serves those too). */
function isStoreFrame(frame: WebFrameMain): boolean {
  if (isWebstorePage(frame.url)) return true
  const parent = frame.parent
  return (
    frame.url === 'about:blank' && !!parent && !parent.isDestroyed() && isWebstorePage(parent.url)
  )
}

async function webGlStatus(): Promise<WebstoreWebGlStatus> {
  try {
    await app.getGPUInfo('basic')
    const status = app.getGPUFeatureStatus() as { webgl?: string }
    return status.webgl?.startsWith('enabled') ? 'webgl_allowed' : 'webgl_blocked'
  } catch {
    return 'webgl_blocked'
  }
}

function summarize(value: unknown): string {
  if (value === undefined) return ''
  const text = JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'string' && v.length > 60 ? `${v.slice(0, 57)}...` : v
  )
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}
