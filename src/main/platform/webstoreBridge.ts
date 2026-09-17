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
import type { StoreId } from '../../core/extensions/store'
import {
  DEFAULT_WEBSTORE_PREFERENCES,
  EMPTY_REFERRER_CHAIN,
  SIGNED_OUT_BROWSER_LOGIN,
  WEBSTORE_CHANNEL,
  WEBSTORE_EVENT_CHANNEL,
  installStatusFor,
  isWebstorePage,
  managementInfoFor,
  parseBeginInstallDetails,
  storeForFrame,
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

type Handler = (args: unknown[], context: CallContext) => Promise<WebstoreReply> | WebstoreReply

interface CallContext {
  win: ZenWindow | undefined
  /** The store whose page is calling; its installs are downloaded from that store first. */
  store: StoreId
}

/**
 * Answers the Chrome Web Store and Edge Add-ons pages' `chrome.webstorePrivate` and
 * `chrome.management` calls (the `preload/webstore.ts` frame preload puts them on the pages) so
 * each store's own install button installs through `ExtensionService`, and forwards registry
 * changes to open store pages as `chrome.management` events. Only frames on the stores' origins
 * are answered, and each is answered for its own store.
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
      'webstorePrivate.beginInstallWithManifest3': async ([details], { win, store }) => {
        const parsed = parseBeginInstallDetails(details)
        if (!parsed) return { value: 'invalid_id', error: 'Invalid extension id' }
        const outcome = await this.extensions.webstoreBeginInstall(parsed, store, win)
        return outcome.result === ''
          ? { value: '' }
          : { value: outcome.result, error: outcome.message }
      },
      'webstorePrivate.completeInstall': ([id], { win }) => this.completeInstall(id, win),
      // Edge's variant carries a correlation vector for its telemetry; the install is the same.
      'webstorePrivate.completeInstallWithCV': ([id], { win }) => this.completeInstall(id, win),
      'webstorePrivate.install': ([id], { win }) => this.completeInstall(id, win),
      'webstorePrivate.enableAppLauncher': () => ({}),
      // Chrome reads `login`; the Edge page reads the account fields. No browser account exists.
      'webstorePrivate.getBrowserLogin': () => ({ value: SIGNED_OUT_BROWSER_LOGIN }),
      'webstorePrivate.getStoreLogin': () => ({ value: '' }),
      'webstorePrivate.setStoreLogin': () => ({}),
      'webstorePrivate.getPreferences': () => ({ value: DEFAULT_WEBSTORE_PREFERENCES }),
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
   * Gives a persistent session's pages the store preload. The header rewrites that make the
   * stores' servers render their install buttons for the same sessions are `webstoreClientHints`
   * and `edgeStoreUserAgent` in `requestHeaders.ts`, registered with the webRequest multiplexer,
   * which owns the session's one `onBeforeSendHeaders` listener.
   */
  attach(ses: Session): void {
    if (ses.getPreloadScripts().some((script) => script.id === WEBSTORE_PRELOAD_ID)) return
    ses.registerPreloadScript({ type: 'frame', id: WEBSTORE_PRELOAD_ID, filePath: webstorePreload })
  }

  private async handle(
    event: IpcMainInvokeEvent,
    member: unknown,
    args: unknown
  ): Promise<WebstoreReply> {
    const frame = event.senderFrame
    const store = frame && !frame.isDestroyed() ? storeOfFrame(frame) : null
    if (!store)
      throw new Error(
        'chrome.webstorePrivate is only available to the Chrome Web Store and Edge Add-ons'
      )
    const handler =
      typeof member === 'string' ? this.handlers[member as keyof typeof this.handlers] : undefined
    if (!handler) throw new Error(`Unknown member ${String(member)}`)
    this.remember(event.sender)
    const started = Date.now()
    try {
      const reply = await handler(Array.isArray(args) ? args : [], {
        win: this.windowFor(event.sender),
        store
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

/** The store of a page's frame, or of a blank child frame of one (the preload serves those too). */
function storeOfFrame(frame: WebFrameMain): StoreId | null {
  const parent = frame.parent
  return storeForFrame(frame.url, parent && !parent.isDestroyed() ? parent.url : null)
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
