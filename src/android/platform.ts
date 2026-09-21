import type {
  DownloadItem,
  EventName,
  Events,
  HapticKind,
  HostCapabilities,
  PageEnvironment,
  Platform as PlatformOs,
  ShareAction,
  ThumbnailPicture
} from '@shared/types'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '@shared/types'
import { interruptReasonFrom, resolveDownloadSettings } from '@shared/downloads'
import { newId } from '@shared/ids'
import type { SharedIntent } from '@shared/shareTarget'
import type { VoiceEvent, VoiceStartOutcome } from '@shared/voice'
import type { QrEvent, QrStartOutcome } from '@shared/qrScan'
import type { ReadAloudVoice } from '@shared/readAloud'
import {
  isDebugApplicationId,
  type UpdateAsset,
  type UpdateProgress,
  type UpdateRelease,
  type UpdateTarget
} from '@shared/updates'
import { Browser } from '@core/browser'
import type { HostExternalRequest } from '@core/externalProtocols'
import { NoExtensions } from '@core/hostDefaults'
import type { SelectionToolbarItem } from '@core/menus'
import { RendererMenuHost } from '@core/rendererMenus'
import type { ZenWindow } from '@core/window'
import type {
  AgentTransport,
  AppHost,
  AutofillHost,
  BlockingHost,
  BundledFilterList,
  ClipboardHost,
  DialogHost,
  DownloadHost,
  EngineDataCounts,
  ExtensionHost,
  ExternalProtocolHost,
  KdfParams,
  KeyEventInput,
  KeyWrapHost,
  MediaSessionAction,
  MediaSessionHost,
  NetHost,
  PasswordsHost,
  PickedTextFile,
  Platform,
  PlatformInfo,
  PrivacyHost,
  QrScanHost,
  PrivateSessionHost,
  ReauthHost,
  SessionHost,
  ShellHost,
  ShortcutHost,
  SpeechHostEvent,
  SpeechHost,
  VoiceHost,
  SystemAutofillStatus,
  ThumbnailHost,
  UpdateHost,
  WebNotificationHost,
  WindowHost,
  WindowHostFactory
} from '@core/platform'
import { KeyWrapError, type KeyWrapFailure } from '@core/platform'
import { PBKDF2_PARAMS, deriveWithWebCrypto } from '@core/credentials/kdf'
import { fromBase64, toBase64 } from '@core/credentials/crypto'
import type { RuleSet } from '@core/blocking/rules'
import type { PrivacyFlags, SafeBrowsingHit, SafeBrowsingThreat } from '@shared/privacy'
import readabilityJs from '@mozilla/readability/Readability.js?raw'
import readabilityReaderableJs from '@mozilla/readability/Readability-readerable.js?raw'
import type { AgentHttpRequest, AgentHttpResponse } from '@core/agent/http'
import type { Bridge } from './bridge'
import type { AndroidExtensions } from './extensionHost'
import {
  fetchBundledFeed,
  readSpilledBody,
  type DeferredDocument,
  type SpilledBody
} from './handoff'
import {
  AndroidExtensionsWithRuntime,
  AndroidExtensionRuntime,
  type ExtMessageEvent,
  type ExtRequestEvent
} from './extensionRuntime'
import { AndroidExtensionStoreIo } from './extensionStoreIo'
import { onFullscreenEntered } from './fullscreenHint'
import { AndroidNewTabBackground } from './newTabBackground'
import { AndroidSyncHost } from './sync'
import { AndroidSiteData } from './siteData'
import { AndroidStoreIO } from './storeIo'
import { AndroidTranslateHost, type TranslateProgressEvent } from './translate'
import { AndroidTabViewHost, type HostHistory, type ViewEventPayloads } from './views'

/** Android 13 (Tiramisu): the first release whose clipboard shows its own "copied" chip. */
const CLIPBOARD_CHIP_SDK = 33

/** Android 8 (Oreo): `Activity.enterPictureInPictureMode` with parameters. */
const PICTURE_IN_PICTURE_SDK = 26

export interface AndroidCapabilityInputs {
  /** `Build.VERSION.SDK_INT`. */
  sdkInt: number
  /** Kotlin named the extension install root: the store and the registry are there to use. */
  extensions: boolean
  /**
   * The WebView injects into named isolated worlds (Chromium 146+, androidx.webkit 1.17). Without
   * them content scripts run in the page's world behind a scope proxy: reduced isolation.
   */
  isolatedWorlds: boolean
  /**
   * The WebView keeps separate profiles (Chrome 111+): containers and the private session have
   * cookies, storage and cache of their own. Without it a "private" tab would browse on the
   * default profile, so none is offered. Absent from an older boot payload: taken as supported.
   */
  profiles?: boolean
}

/** What the Android host can do for the chrome; a few points depend on the OS release. */
export function androidCapabilities({
  sdkInt,
  extensions,
  isolatedWorlds,
  profiles = true
}: AndroidCapabilityInputs): HostCapabilities {
  return {
    windowControls: false,
    windowControlsOverlay: false,
    windowMaterial: false,
    nativeMenus: false,
    windowDrag: false,
    devtools: false,
    compactReveal: false,
    // The window goes into the OS's picture-in-picture for a playing video (Android 8+).
    pictureInPicture: sdkInt >= PICTURE_IN_PICTURE_SDK,
    viewSource: false,
    windows: false,
    extensions,
    resourceGovernor: false,
    // The engine runs in the chrome over a Storage Access Framework folder (`sync.ts`, ID-08).
    sync: true,
    print: true,
    // The system print flow (`PrintRelay.kt`) has its own preview; no PDF rendering in the WebView.
    printPreview: false,
    // The WebView cannot draw a PDF: one it navigates to is downloaded and shown in `zen://pdf`.
    pdfViewer: true,
    agents: true,
    updates: true,
    share: true,
    clipboardChip: sdkInt >= CLIPBOARD_CHIP_SDK,
    appLinkSettings: true,
    pullToRefresh: true,
    passwords: true,
    defaultBrowser: true,
    requestBlocking: true,
    pageControls: true,
    darkenSites: true,
    reducedExtensionIsolation: extensions && !isolatedWorlds,
    // One window: private browsing is a tab in it, on a throwaway WebView profile.
    privateTabs: profiles,
    secureDns: false,
    // The WebView has no preload bridge for `zen://newtab` yet; new tabs stay URL-bar-only.
    newTabPage: false,
    pageTabs: true,
    pinShortcuts: false,
    translate: true,
    voiceSearch: false,
    screenCapture: false,
    shareSheet: false,
    // The WebView's floating action mode, with Zenium's items added after Copy (`TabWebView.kt`).
    selectionToolbar: true,
    // One document: the picker is drawn in the chrome, above the keyboard.
    popupSurface: false,
    qrScan: false,
    // Until boot says the device has a text-to-speech engine (`ReadAloud.kt`; `Platform.speech`).
    readAloud: false
  }
}

/**
 * What `vault.wrap` / `vault.unwrap` answer: the result, or the refusal Kotlin could name (a
 * dismissed prompt, a key that wants an authentication a silent call cannot ask for, a key the
 * device invalidated when the screen lock changed).
 */
type KeyWrapReply = string | { failure: KeyWrapFailure; message: string }

function keyWrapResult(reply: KeyWrapReply): string {
  if (typeof reply === 'string') return reply
  throw new KeyWrapError(reply.failure, reply.message)
}

/**
 * The vault's data key is wrapped by an AES-GCM key that never leaves the Android Keystore
 * (`VaultKeystore.kt`). Kotlin asks for the device credential when the key demands a recent
 * authentication and the call is interactive. Passphrase wrappings use WebCrypto PBKDF2 in the
 * chrome WebView (a secure context: `https://appassets.androidplatform.net`).
 */
class AndroidKeyWrap implements KeyWrapHost {
  constructor(private readonly bridge: Bridge) {}

  osAvailable(): Promise<boolean> {
    return this.bridge.call<boolean>('vault.available')
  }

  async wrap(dataKey: Uint8Array): Promise<string> {
    const reply = await this.bridge.call<KeyWrapReply>('vault.wrap', { key: toBase64(dataKey) })
    return keyWrapResult(reply)
  }

  async unwrap(blob: string, interactive: boolean): Promise<Uint8Array> {
    const reply = await this.bridge.call<KeyWrapReply>('vault.unwrap', { blob, interactive })
    return fromBase64(keyWrapResult(reply))
  }

  kdfParams(): KdfParams {
    return PBKDF2_PARAMS
  }

  deriveKey(passphrase: string, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> {
    return deriveWithWebCrypto(passphrase, salt, params)
  }
}

/** `androidx.biometric` BiometricPrompt: fingerprint or face where enrolled, else the device PIN. */
class AndroidReauth implements ReauthHost {
  constructor(private readonly bridge: Bridge) {}

  available(): Promise<boolean> {
    return this.bridge.call<boolean>('reauth.available')
  }

  verify(reason: string): Promise<boolean> {
    return this.bridge.call<boolean>('reauth.verify', { reason })
  }
}

/**
 * The system Autofill Framework (`AutofillManager`): whether the user has an autofill service,
 * and whether the page WebViews take part in it. Android has no callback for the service
 * changing, so the status is probed again whenever the Activity returns to the foreground.
 */
class AndroidAutofillHost implements AutofillHost {
  private listener: ((status: SystemAutofillStatus) => void) | null = null
  private last: SystemAutofillStatus | null = null

  constructor(private readonly bridge: Bridge) {}

  async systemStatus(): Promise<SystemAutofillStatus> {
    const status = statusFrom(await this.bridge.call<unknown>('autofill.status'))
    this.last = status
    return status
  }

  setProvider(provider: 'system' | 'zenium'): void {
    this.bridge.send('autofill.setProvider', { provider })
  }

  onSystemStatusChanged(listener: (status: SystemAutofillStatus) => void): void {
    this.listener = listener
  }

  /** The app is back in front: the user may have set or removed a service meanwhile. */
  refresh(): void {
    if (!this.listener) return
    const before = this.last
    void this.systemStatus()
      .then((status) => {
        if (before && before.enabled === status.enabled && before.service === status.service) return
        this.listener?.(status)
      })
      .catch(() => undefined)
  }
}

/** Kotlin's `autofill.status` reply, checked field by field. */
export function statusFrom(raw: unknown): SystemAutofillStatus {
  if (!raw || typeof raw !== 'object') return { enabled: false, service: null }
  const o = raw as Record<string, unknown>
  return {
    enabled: o.enabled === true,
    service: typeof o.service === 'string' && o.service ? o.service : null
  }
}

/** Everything Kotlin hands over synchronously before the chrome renders. */
export interface BootInfo {
  version: string
  /**
   * The OS the chrome reports as its platform. The Kotlin host never sets it (Android); the
   * preview host may name a desktop OS so a desktop-form-factor capture shows the desktop's
   * platform-bound rows (`?platform=linux`).
   */
  os?: PlatformOs
  /** `Build.VERSION.SDK_INT` of the device (the newest release the preview host stands in for). */
  sdkInt: number
  /** Hex SHA-256 of the certificate this APK is signed with (null in the preview host). */
  signer: string | null
  /** The applicationId this APK was installed under (null in the preview host). */
  packageName: string | null
  /** Whether the WebView supports multiple profiles (see `AndroidCapabilityInputs.profiles`). */
  profiles?: boolean
  /** The launcher icon colour whose alias is enabled right now (the core re-applies its own). */
  appIcon?: string
  /** The launcher accepts pinned shortcuts (`ShortcutManagerCompat.isRequestPinShortcutSupported`). */
  pinShortcuts?: boolean
  /** The device has a speech recogniser (`SpeechRecognizer.isRecognitionAvailable`, `Voice.kt`). */
  voiceSearch?: boolean
  /** The device has a back camera to scan QR codes with (`QrScan.kt`). */
  qrScan?: boolean
  /** The device has a text-to-speech engine (`ReadAloud.kt`: an installed TTS service); `Platform.speech` speaks through it. */
  readAloud?: boolean
  /** `Build.MODEL`: what sync calls this device until the user renames it (absent in old hosts). */
  deviceModel?: string
  /** Persisted JSON documents by name (state.json, history.json, …), the ones small enough to inline. */
  files: Record<string, string>
  /**
   * The documents too big for the payload (a Safe Browsing feed's table), by name, size and
   * version tag; fetched from the document handler before the core starts (`handoff.ts`).
   * Absent from an older host and from the preview host.
   */
  deferred?: DeferredDocument[]
  downloadsDir: string
  /**
   * Absolute path of `files/zen/extensions`, where the extension store installs (absent in the
   * preview host, which has no files and therefore no extensions).
   */
  extensionsRoot?: string
  /**
   * The WebView can inject scripts into named isolated worlds (`Extensions.isolatedWorlds`, read
   * once at start): decides the `reducedExtensionIsolation` capability before any extension runs.
   */
  isolatedWorlds?: boolean
  insets: { top: number; right: number; bottom: number; left: number }
  fullscreen: boolean
  /** Screen class, peripherals and font scale for the page controls (absent in old hosts). */
  environment?: PageEnvironment
  /**
   * An accessibility service explores the screen by touch (TalkBack;
   * `AccessibilityManager.isTouchExplorationEnabled`): the bar that hides on scroll stays put
   * (`lib/barHide.ts`). Changes come as `__zenHost.barTouchExploration`. Absent in old hosts
   * and in the preview host.
   */
  touchExploration?: boolean
  /**
   * The device has a screen lock (or an enrolled biometric) to verify the user with
   * (`Reauth.available`, `BiometricManager.canAuthenticate`): Settings' "Lock private tabs when
   * you leave Zenium" is enabled (`lib/privateLock.ts`). Changes come as `private.lock`. Absent
   * in old hosts and in the preview host.
   */
  screenLock?: boolean
}

/**
 * The window's safe-area insets in CSS px (`MainActivity.applyInsets`), and whether the system
 * bars are still on their way back from a page's fullscreen (`FullscreenLanding.kt`).
 */
export interface WindowInsets {
  top: number
  right: number
  bottom: number
  left: number
  settling?: boolean
}

/**
 * The insets as a host reports them, every side a finite number: a side the payload lacks or
 * garbles (the boot payload of a host asked before its first inset dispatch) is 0, never
 * `undefined`, which the chrome would write as `--zen-inset-top: undefinedpx` and lose the
 * shell's `calc()` padding to.
 */
export function windowInsetsOf(payload: unknown): WindowInsets {
  const raw = (payload ?? {}) as Partial<Record<keyof WindowInsets, unknown>>
  const side = (value: unknown): number => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const insets: WindowInsets = {
    top: side(raw.top),
    right: side(raw.right),
    bottom: side(raw.bottom),
    left: side(raw.left)
  }
  if (typeof raw.settling === 'boolean') insets.settling = raw.settling
  return insets
}

/** Events Kotlin raises for the whole app (`__zenHost.hostEvent(name, payload)`). */
export interface HostEventPayloads {
  /**
   * The window's safe-area insets, and whether the system bars are still on their way back from
   * a page's fullscreen (`FullscreenLanding.kt`): the chrome's return fade waits while they are
   * (`lib/fullscreenLanding.ts`). Absent from a host without the word.
   */
  insets: WindowInsets
  /** A configuration change: screen class, keyboard / mouse or font scale differ now. */
  environment: PageEnvironment
  focus: { focused: boolean }
  fullscreen: { fullscreen: boolean }
  openUrl: { url: string }
  /** Another app shared into Zenium (`ACTION_SEND`) or asked it to search (`ACTION_WEB_SEARCH`). */
  intent: SharedIntent
  /** A page wants to open another app; Kotlin holds the navigation until `externalProtocol.respond`. */
  'externalProtocol.request': HostExternalRequest
  /** A tap on one of Zenium's own buttons in the system share sheet (Android 14). */
  'share.action': ShareAction
  /**
   * A Zenium item of a page's floating text-selection toolbar was touched (`TabWebView.kt`,
   * the items `selectionMenu` listed): the action's id, the text selected at the touch and
   * where the selection sits in the page (0…1 of its width and height).
   */
  'selection.action': {
    tabId: string
    id: string
    text: string
    originX?: number
    originY?: number
  }
  pause: void
  /** The window is coming back on screen after being hidden (screen off, another app in front). */
  resume: void
  /**
   * The system is short of memory (`onTrimMemory`, graded by `HostLifecycle.memoryPressure`):
   * hidden pages go to sleep ahead of their timeout, all of them when the process is about to
   * be killed.
   */
  memoryPressure: { level: 'low' | 'critical' }
  /** A page view's visibility change (`view.setVisible`) is on screen (`Host.setTabVisible`). */
  'view.drawn': { tabId: string; visible: boolean }
  /**
   * A page view laid out at a new size (CSS px) has drawn the page at it (`Host.viewSized`):
   * the chrome's return from a fullscreen fades in on the page's landing (`lib/fullscreenLanding.ts`).
   */
  'view.sized': { tabId: string; width: number; height: number }
  /** Kotlin took a tab card picture and has it on disk (`Thumbnails.kt`). */
  'thumbnail.captured': ThumbnailPicture & { tabId: string }
  /**
   * A tab WebView's back/forward list changed, as the app-wide form of the view event of the
   * same name (`AndroidTabView.dispatch('historyChanged')`): routed to the view named.
   */
  historyChanged: HostHistory & { tabId: string }
  'download.started': {
    token: string
    url: string
    referrer: string
    filename: string
    totalBytes: number
    mimeType: string
    sourceTabId: string | null
    /** Container of the WebView the download came from (its profile); private follows from it. */
    containerId: string
    /** Set when Kotlin continues an interrupted record after a restart or retries one (the record's id). */
    resumes?: string
    savePath?: string
    canResume?: boolean
    /**
     * The response the tab's own navigation produced (the WebView's `DownloadListener`, no
     * `download` attribute behind it), as against a "Download link" or a retry: what decides
     * whether a PDF opens in the viewer (`core/pdf.ts`).
     */
    navigation?: boolean
    /** The response's Content-Disposition type, when it named one. */
    disposition?: 'inline' | 'attachment' | null
  }
  'download.progress': {
    token: string
    receivedBytes: number
    totalBytes: number
    state: 'progressing' | 'paused' | 'interrupted'
    canResume?: boolean
    etag?: string
    lastModified?: string
    savePath?: string
    /** The name the file is actually written under (MediaStore may have made it unique). */
    finalName?: string
    mimeType?: string
    /** A `DownloadInterruptReason` (Kotlin's `DownloadInterruptReason.wire`) while `interrupted`. */
    error?: string
    /**
     * Epoch ms of the downloader's own next attempt, with an `interrupted` report a network
     * failure it will retry produced (`Downloads.kt` keeps Chromium's automatic resume itself;
     * the core schedules none for Android, `autoResume: 'host'`).
     */
    autoResumeAt?: number
  }
  'download.done': {
    token: string
    /**
     * `insecure-blocked`: the downloader followed the redirects itself and refused the body
     * under Chrome's mixed-content rule (an `http:` hop under an `https:` page); nothing was
     * written.
     */
    state: 'completed' | 'cancelled' | 'interrupted' | 'insecure-blocked'
    savePath: string
    finalName: string
    receivedBytes?: number
    totalBytes?: number
    canResume?: boolean
    /** A `DownloadInterruptReason` when `interrupted`; `dismissed` on a `cancelled` save dialog. */
    error?: string
    mimeType?: string
  }
  /** Pause / Resume / Cancel pressed on the download's system notification. */
  'download.action': { id: string; op: 'pause' | 'resume' | 'cancel' }
  'permission.request': {
    requestId: string
    permission: string
    url: string
    /** The page's tab: the prompt queues under it and goes away when it navigates. */
    tabId?: string
    /** `media`: which capture devices the page asked for. */
    mediaTypes?: Array<'video' | 'audio'>
  }
  /** A server asked for HTTP credentials; answered with `auth.respond`. */
  'auth.request': { requestId: string; tabId: string; host: string; realm: string; url: string }
  'view.adopt': { viewId: string; parentTabId: string | null; active: boolean }
  /** An HTTP request reached the Kotlin MCP socket server; answered with `agent.reply`. */
  'agent.request': { id: number } & AgentHttpRequest
  /** Bytes of a release APK arriving (`update.download` in flight). */
  'update.progress': { token: string; transferred: number; total: number; bytesPerSecond: number }
  /**
   * A `.crx` or `.zip` another app opened with or shared to Zenium (`ACTION_VIEW` / `ACTION_SEND`):
   * Kotlin copied it to a package file and queued it for `extStore.takeSideloads`; the payload
   * says how many wait. A nudge rather than the handle itself so that one arriving while the
   * chrome is still booting is not lost: the store collects the queue when it starts, too.
   */
  'extension.sideload': { count: number }
  /** A bridge message from a content-script frame or an extension page (`ext/Extensions.kt`). */
  'ext.message': ExtMessageEvent
  /** Endpoints whose frame or page went away. */
  'ext.gone': { eps: string[] }
  /** The popup / options sheet was dismissed (back gesture, a tap outside, `window.close()`). */
  'ext.popupClosed': { id: string }
  /** One intercepted request, while an extension listens for `webRequest` events. */
  'ext.request': ExtRequestEvent
  /**
   * An `identity.launchWebAuthFlow` sheet (`ext/ExtensionAuthSheet.kt`) reports a top-frame
   * navigation (one back to `https://<id>.chromiumapp.org/…` is cancelled there and ends the
   * flow), a page loaded, a page failed, or its dismissal by the user.
   */
  'ext.authView': { viewId: number; event: string; url?: string }
  /** A tap, a button or a swipe on an extension's system notification (`ext/ExtensionNotifications.kt`). */
  'ext.notification': { id: string; notificationId: string; event: string; index?: number }
  /** Bytes of a translation model file arriving (`translate.download` in flight). */
  'translate.progress': TranslateProgressEvent
  /** The launcher confirmed a `shortcut.pin` request (the user accepted the system dialog). */
  'shortcut.pinned': { id: string }
  /** The speech recogniser reports while a voice search runs (`Voice.kt`; `shared/voice.ts`). */
  'voice.event': VoiceEvent
  /** The camera reports while a QR scan runs (`QrScan.kt`; `shared/qrScan.ts`). */
  'qr.event': QrEvent
  /** The text-to-speech engine reports on an utterance (`ReadAloud.kt`; `SpeechHost.onEvent`). */
  'speech.event': { utteranceId: string } & SpeechHostEvent
  /** The engine's voices changed (the engine was swapped or a voice installed): `SpeechHost.onVoicesChanged`. */
  'speech.voicesChanged': null
  /**
   * The OS media controls acted (`MediaSessions.kt`: the notification, the lock screen, a
   * headset button, the PiP window's buttons): the Media Session action for the tab the
   * controls showed (null: whichever holds the session), `seekTime` for `seekto` in seconds.
   */
  'media.action': {
    tabId: string | null
    action: MediaSessionAction | 'toggle'
    seekTime?: number
    seekOffset?: number
  }
  /** The window entered (`active`) or left picture-in-picture, showing `tabId`'s page (`MediaSessions.kt`). */
  'media.pip': { tabId: string; active: boolean; dismissed?: boolean }
  /** A tap on the media notification: the session's tab comes to the front (`MediaSessions.kt`). */
  'media.reveal': { tabId: string }
  /**
   * The shade's tap (`click`) or swipe (`close`) on a page's notification, or its quiet
   * replacement by a later one with the same tag (`WebNotifications.kt`); `url` is the page's,
   * for a tap on a notification that outlived the core.
   */
  'notification.event': { id: string; event: 'click' | 'close' | 'replaced'; url?: string }
  /** The user blocked a site's notification channel in the system settings: the site's permission follows. */
  'notification.blocked': { origin: string }
  /** "Close all private tabs" pressed on the private session's notification (`PrivateSession.kt`). */
  'private.closeAll': Record<string, never>
  /**
   * A page's element went fullscreen: the engine's view is up in the fullscreen layer
   * (`Host.enterFullscreen`), a video's, a canvas's or an embed's alike. The first-time exit
   * hint's cue (GN-20); the video's size, which turns the screen, stays the host's own.
   */
  'fullscreen.entered': { tabId: string }
  /**
   * A toast the host raises itself on the chrome's message cards (v2 §9.33), where it cannot
   * go through the core's own (`Browser.toast` has no action): the file chooser's camera
   * refused, `action: 'settings'` for a refusal for good, whose Open settings is the app's
   * details page (`app.openSettings`). Handled in `boot.ts`, where the renderer is in reach.
   */
  toast: { message: string; kind?: 'info' | 'error'; action?: 'settings' }
  /**
   * "Lock private tabs when you leave Zenium" (`PrivateLock.kt`): the lock went on as the
   * window left, or came off (the screen lock passed, the last private tab closed, the switch
   * turned off), and whether the device has a screen lock to pass it with (read again on every
   * return). The chrome's alone (`lib/privateLock.ts`, routed in `boot.ts`): the core keeps only
   * the switch.
   */
  'private.lock': { locked: boolean; screenLock: boolean }
}

/**
 * Updates on Android: Kotlin downloads the APK the core picked, verifies its SHA-256 and starts
 * the package installer; Android itself asks the user to confirm.
 */
class AndroidUpdateHost implements UpdateHost {
  private token: string | null = null
  private cancelled = false
  private progress: ((progress: UpdateProgress) => void) | null = null

  constructor(
    private readonly bridge: Bridge,
    private readonly signerSha256: string | null,
    private readonly installedPackage: string | null
  ) {}

  /** A debug build is a development build: it never looks for releases by itself (see `isDebugApplicationId`). */
  target(): UpdateTarget {
    return {
      os: 'android',
      arch: 'universal',
      kind: isDebugApplicationId(this.installedPackage) ? 'dev' : 'apk'
    }
  }

  publicKeys(): string[] {
    return (import.meta.env.VITE_ZEN_UPDATE_PUBLIC_KEY ?? '')
      .split(/[\s,]+/)
      .map((key) => key.trim())
      .filter(Boolean)
  }

  signer(): string | null {
    return this.signerSha256
  }

  packageName(): string | null {
    return this.installedPackage
  }

  async download(
    _release: UpdateRelease,
    asset: UpdateAsset,
    onProgress: (progress: UpdateProgress) => void
  ): Promise<string> {
    if (this.token) throw new Error('a download is already running')
    const token = newId('update')
    this.token = token
    this.cancelled = false
    this.progress = onProgress
    try {
      const result = await this.bridge.call<{
        ok: boolean
        path?: string
        cancelled?: boolean
        error?: string
      }>('update.download', {
        token,
        url: asset.url,
        name: asset.name,
        size: asset.size,
        sha256: asset.sha256
      })
      if (result.ok && result.path) return result.path
      if (result.cancelled || this.cancelled) {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        throw error
      }
      throw new Error(result.error || 'download failed')
    } finally {
      this.token = null
      this.progress = null
    }
  }

  async install(_release: UpdateRelease, downloadedPath: string | null): Promise<void> {
    if (!downloadedPath) throw new Error('nothing has been downloaded')
    const result = await this.bridge.call<{ ok: boolean; reason?: string }>('update.install', {
      path: downloadedPath
    })
    if (result.ok) return
    if (result.reason === 'permission')
      throw new Error(
        'Android needs permission first: allow Zenium to install apps in the screen that just opened, then tap Install again.'
      )
    throw new Error(result.reason || 'could not start the package installer')
  }

  cancel(): void {
    if (!this.token) return
    this.cancelled = true
    this.bridge.send('update.cancel', { token: this.token })
  }

  onProgress(payload: HostEventPayloads['update.progress']): void {
    if (payload.token !== this.token || !this.progress) return
    const total = payload.total > 0 ? payload.total : 0
    this.progress({
      percent: total > 0 ? Math.min(100, (payload.transferred / total) * 100) : 0,
      transferred: payload.transferred,
      total,
      bytesPerSecond: payload.bytesPerSecond
    })
  }
}

/**
 * The MCP server's socket lives in Kotlin (a foreground service keeps it alive while the app is
 * in the background); requests are relayed into the core and answered through the bridge.
 */
class AndroidAgentTransport implements AgentTransport {
  private onRequest: ((request: AgentHttpRequest) => Promise<AgentHttpResponse>) | null = null

  constructor(private readonly bridge: Bridge) {}

  async start(options: {
    port: number
    lan: boolean
    onRequest: (request: AgentHttpRequest) => Promise<AgentHttpResponse>
  }): Promise<{ port: number; lanAddresses: string[] }> {
    this.onRequest = options.onRequest
    return this.bridge.call<{ port: number; lanAddresses: string[] }>('agent.start', {
      port: options.port,
      lan: options.lan
    })
  }

  async stop(): Promise<void> {
    this.onRequest = null
    await this.bridge.call('agent.stop')
  }

  handle(payload: HostEventPayloads['agent.request']): void {
    const { id, ...request } = payload
    const reply = (response: AgentHttpResponse): void => {
      this.bridge.send('agent.reply', { id, ...response })
    }
    if (!this.onRequest) {
      reply({ status: 503, headers: { 'content-type': 'text/plain' }, body: 'MCP server stopped' })
      return
    }
    this.onRequest(request)
      .then(reply)
      .catch((error: Error) =>
        reply({
          status: 500,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: error.message }
          })
        })
      )
  }
}

type Listener = (payload: unknown) => void

/**
 * The events that describe a state of the window rather than a moment: a subscriber that comes
 * late gets the latest one on subscribing. The host's `insets` is one. It is sent at boot from
 * the boot payload and again as Kotlin's queued `insets` events are flushed – both before React
 * has rendered and `useMainEvents` has subscribed, whenever the boot yields to fetch a deferred
 * document (`fetchDeferredDocuments`, any profile document over `BOOT_INLINE_LIMIT`). Android
 * dispatches insets again only when they change (the keyboard, a turn), so without the replay
 * the chrome laid itself out under the status bar until then (Bennett's 0.3.79 report).
 */
const STICKY_EVENTS: ReadonlySet<EventName> = new Set<EventName>(['insets'])

/** In-process event fan-out: the chrome runs in the same document as the core. */
export class InProcessEvents {
  private readonly listeners = new Map<string, Set<Listener>>()
  /** The last payload of each sticky event ({@link STICKY_EVENTS}), replayed to a new subscriber. */
  private readonly latest = new Map<string, unknown>()

  send<K extends EventName>(name: K, payload: Events[K]): void {
    if (STICKY_EVENTS.has(name)) this.latest.set(name, payload)
    const set = this.listeners.get(name)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch (error) {
        console.error(`[zen] event listener for ${name} failed`, error)
      }
    }
  }

  on<K extends EventName>(name: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(name)
    if (!set) {
      set = new Set()
      this.listeners.set(name, set)
    }
    const wrapped = listener as Listener
    set.add(wrapped)
    if (this.latest.has(name)) {
      try {
        listener(this.latest.get(name) as Events[K])
      } catch (error) {
        console.error(`[zen] event listener for ${name} failed on the replay`, error)
      }
    }
    return () => {
      set?.delete(wrapped)
    }
  }
}

/**
 * The one window of the Android app. Its "chrome" is the document the core runs in, so events
 * are delivered in-process; the frame (fullscreen, focus, backgrounding) is the Activity.
 */
export class AndroidWindowHost implements WindowHost {
  focused = true
  fullscreen = false
  readonly alive = true

  constructor(
    private readonly bridge: Bridge,
    private readonly events: InProcessEvents
  ) {}

  send<K extends EventName>(name: K, payload: Events[K]): void {
    this.events.send(name, payload)
  }

  focusChrome(): void {
    this.bridge.send('chrome.focus')
  }

  haptic(kind: HapticKind): void {
    this.bridge.send('chrome.haptic', { kind })
  }

  openChromeDevTools(): void {
    // Chrome's remote inspector (chrome://inspect) attaches to the chrome WebView.
  }

  contentSize(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight }
  }

  isFullScreen(): boolean {
    return this.fullscreen
  }

  setFullScreen(fullscreen: boolean): void {
    this.bridge.send('window.setFullscreen', { fullscreen })
  }

  isMaximized(): boolean {
    return true
  }

  isFocused(): boolean {
    return this.focused
  }

  isVisible(): boolean {
    return true
  }

  minimize(): void {
    this.bridge.send('app.background')
  }

  /* eslint-disable @typescript-eslint/no-empty-function -- the Activity is always maximised */
  maximize(): void {}
  unmaximize(): void {}
  show(): void {}
  focus(): void {}
  // Android has a single Activity with no window switcher, so the native title is never shown.
  setTitle(): void {}
  /* eslint-enable @typescript-eslint/no-empty-function */

  close(): void {
    this.bridge.send('app.quit')
  }

  normalBounds(): null {
    return null
  }
}

/** The bundled filter-list snapshot lives in the APK's assets; Kotlin copies it into the profile. */
class AndroidBlockingHost implements BlockingHost {
  constructor(private readonly bridge: Bridge) {}

  async bundledLists(): Promise<BundledFilterList[]> {
    const raw = await this.bridge.call<unknown[] | null>('blocking.bundled')
    if (!Array.isArray(raw)) return []
    return raw.flatMap((l) => {
      const list = bundledListFrom(l)
      return list ? [list] : []
    })
  }

  async installBundled(set: RuleSet, file: string): Promise<BundledFilterList | null> {
    return bundledListFrom(await this.bridge.call<unknown>('blocking.install', { set, file }))
  }
}

/**
 * The privacy policy goes to Kotlin as one document (`privacy/Privacy.kt` keeps the latest):
 * the Safe Browsing guard's switch and bypasses, the cookie mode for `CookieManager`, the GPC
 * and DNT headers and their `navigator` script, HTTPS-only mode's allowed sites. Secure DNS is
 * the system's business on Android (`secureDns: false`). The bundled Safe Browsing snapshot is
 * in the APK's assets (`assets/safebrowsing/<id>.json`), fetched through the asset loader – a
 * few hundred kilobytes that would otherwise come JSON-quoted through a script – and read
 * through Kotlin when the fetch cannot bring it (a chrome on another origin).
 *
 * The Safe Browsing tables are Kotlin's (`privacy/SafeBrowsing.kt` reads the feed documents the
 * core writes and checks every request against them, ahead of the rule engine): the core's
 * service keeps the documents' metadata and the refresh schedule only, reads the documents after
 * boot rather than through it, and asks here – `privacy.lookup` – where it needs a table's word
 * (a download's verdict).
 */
class AndroidPrivacyHost implements PrivacyHost {
  readonly safeBrowsingTables = 'host' as const

  constructor(private readonly bridge: Bridge) {}

  apply(flags: PrivacyFlags): void {
    this.bridge.send('privacy.apply', { flags })
  }

  async bundledSafeBrowsingFeed(id: string): Promise<string | null> {
    const fetched = await fetchBundledFeed(id, (url, init) => fetch(url, init))
    if (fetched !== null) return fetched
    const raw = await this.bridge.call<unknown>('privacy.bundledFeed', { id })
    return typeof raw === 'string' && raw ? raw : null
  }

  async lookupSafeBrowsing(url: string): Promise<SafeBrowsingHit | null> {
    return safeBrowsingHitFrom(await this.bridge.call<unknown>('privacy.lookup', { url }))
  }
}

/** Kotlin's `SafeBrowsingHit.toJson()` (`blocking/Policy.kt`), checked field by field; null for no hit. */
export function safeBrowsingHitFrom(raw: unknown): SafeBrowsingHit | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.feedId !== 'string' || typeof o.expression !== 'string') return null
  const threat = typeof o.threat === 'string' ? o.threat : 'unknown'
  return {
    feedId: o.feedId,
    threat: isSafeBrowsingThreat(threat) ? threat : 'unknown',
    expression: o.expression,
    remote: false
  }
}

function isSafeBrowsingThreat(value: string): value is SafeBrowsingThreat {
  return value === 'malware' || value === 'phishing' || value === 'unwanted' || value === 'unknown'
}

/** Kotlin's description of a bundled list, checked field by field. */
export function bundledListFrom(raw: unknown): BundledFilterList | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (
    typeof o.id !== 'string' ||
    typeof o.builtAt !== 'number' ||
    typeof o.filterCount !== 'number'
  )
    return null
  return {
    id: o.id,
    version: typeof o.version === 'string' ? o.version : null,
    builtAt: o.builtAt,
    filterCount: o.filterCount
  }
}

/**
 * Zen's browser core running inside the chrome WebView on Android. Kotlin owns the tab
 * WebViews, downloads, permissions and dialogs; this class turns the `Platform` contract into
 * bridge calls and routes Kotlin's events back into the core.
 */
export class AndroidPlatform implements Platform {
  readonly info: PlatformInfo
  readonly capabilities: HostCapabilities
  readonly io: AndroidStoreIO
  readonly events = new InProcessEvents()
  readonly windows: WindowHostFactory
  readonly views: AndroidTabViewHost
  readonly menus: RendererMenuHost
  readonly dialogs: DialogHost
  readonly clipboard: ClipboardHost
  readonly shell: ShellHost
  readonly net: NetHost
  readonly downloads: DownloadHost
  readonly sessions: SessionHost
  readonly app: AppHost
  readonly siteData: AndroidSiteData
  readonly externalProtocols: ExternalProtocolHost
  readonly passwords: PasswordsHost
  readonly autofill: AndroidAutofillHost
  readonly blocking: BlockingHost
  readonly privacy: PrivacyHost
  readonly translate: AndroidTranslateHost
  readonly shortcuts: ShortcutHost
  readonly voice: VoiceHost
  /**
   * The speech engine (`ReadAloud.kt`), on devices that have one: boot's `readAloud` says
   * whether a text-to-speech service is installed (the package manager's answer, no binding),
   * and without one the host is left out, so `capabilities.readAloud` is false, the core's
   * `readAloud.available` is false and the entry points stay hidden (interface 3.2).
   */
  readonly speech?: SpeechHost
  private speechListeners: Array<(utteranceId: string, event: SpeechHostEvent) => void> = []
  private voicesListeners: Array<() => void> = []
  /**
   * Tab card pictures, Kotlin's (`Thumbnails.kt`, `cacheDir/zen-thumbs/<tabId>.jpg`): it takes
   * them and raises `thumbnail.captured`; the chrome reads one when it shows the card.
   */
  readonly thumbnails: ThumbnailHost
  readonly qrScan: QrScanHost
  readonly mediaSession: MediaSessionHost
  readonly webNotifications: WebNotificationHost
  readonly privateSession: PrivateSessionHost
  /** The new tab page's picked wallpaper, in its own document (`newtab-wallpaper.json`). */
  readonly newTabBackground: AndroidNewTabBackground
  /** Cross-device sync over a Storage Access Framework folder (`sync.ts`; the engine is the core's). */
  readonly sync: AndroidSyncHost
  browser!: Browser
  private windowHost: AndroidWindowHost | null = null
  private zenWindow: ZenWindow | null = null
  private readonly downloadTokens = new Map<string, string>()
  private readonly agentTransport: AndroidAgentTransport
  private readonly updateHost: AndroidUpdateHost
  /** `files/zen/extensions` when Kotlin has one; the preview host installs nothing. */
  private readonly extensionsRoot: string | null
  private extensions: AndroidExtensions | null = null
  /** The runtime behind the store, once `createExtensions` built it (null in the preview host). */
  private extensionRuntime: AndroidExtensionRuntime | null = null
  private readonly bootEnvironment: PageEnvironment | null

  /**
   * `io` is the profile's store, complete: `bootAndroid` builds it and adopts the documents the
   * payload deferred before the platform, because the constructor reads from it (the new tab
   * background's document) and so does every core constructor after it. Built here from the
   * payload alone when not given (the tests; a document the payload deferred is then read
   * through the bridge, `AndroidStoreIO`).
   */
  constructor(
    private readonly bridge: Bridge,
    boot: BootInfo,
    io: AndroidStoreIO = new AndroidStoreIO(bridge, boot.files, boot.deferred)
  ) {
    this.info = { os: boot.os ?? 'android', version: boot.version }
    this.extensionsRoot = boot.extensionsRoot || null
    this.capabilities = {
      ...androidCapabilities({
        sdkInt: boot.sdkInt,
        extensions: this.extensionsRoot !== null,
        isolatedWorlds: boot.isolatedWorlds === true,
        profiles: boot.profiles
      }),
      pinShortcuts: boot.pinShortcuts === true,
      voiceSearch: boot.voiceSearch === true,
      qrScan: boot.qrScan === true,
      readAloud: boot.readAloud === true
    }
    this.bootEnvironment = boot.environment ?? null
    this.io = io
    this.newTabBackground = new AndroidNewTabBackground(this.io)
    this.sync = new AndroidSyncHost(bridge, boot.deviceModel ?? '')
    this.agentTransport = new AndroidAgentTransport(bridge)
    this.updateHost = new AndroidUpdateHost(bridge, boot.signer ?? null, boot.packageName ?? null)
    this.views = new AndroidTabViewHost(bridge)
    this.siteData = new AndroidSiteData(bridge)
    this.blocking = new AndroidBlockingHost(bridge)
    this.privacy = new AndroidPrivacyHost(bridge)
    this.translate = new AndroidTranslateHost(bridge)
    this.menus = new RendererMenuHost()
    this.windows = {
      create: (win: ZenWindow): WindowHost => {
        if (this.windowHost) throw new Error('Android hosts a single window')
        const host = new AndroidWindowHost(bridge, this.events)
        host.fullscreen = boot.fullscreen
        this.windowHost = host
        this.zenWindow = win
        // The chrome document is already running; report it ready once the core has the host.
        queueMicrotask(() => win.onChromeReady())
        return host
      }
    }
    this.dialogs = {
      confirm: (options) => bridge.call<boolean>('dialog.confirm', options),
      pickTextFiles: (options) => bridge.call<PickedTextFile[]>('dialog.openText', options),
      saveTextFile: (options) => bridge.call<boolean>('dialog.saveText', options)
    }
    this.passwords = { keys: new AndroidKeyWrap(bridge), reauth: new AndroidReauth(bridge) }
    this.autofill = new AndroidAutofillHost(bridge)
    this.clipboard = {
      // `sensitive` becomes ClipDescription.EXTRA_IS_SENSITIVE (Android 13+): no preview of the secret.
      writeText: (text, sensitive) =>
        bridge.send('clipboard.writeText', { text, sensitive: sensitive === true }),
      writeImageFromUrl: (url) => bridge.call<boolean>('clipboard.writeImage', { url }),
      clearText: (expected) => bridge.call('clipboard.clearText', { expected }),
      // The URL bar's clipboard row: `peek` reads the clip's description alone (no Android 12+
      // toast), `read` its text once on the user's reveal or pick, `markUsed` remembers the clip
      // the user opened so it is not offered again until the clipboard changes (ClipboardPeek.kt).
      peek: async () => {
        const kind = await bridge.call<string>('clipboard.peek', {})
        return kind === 'url' || kind === 'text' || kind === 'image' ? kind : 'none'
      },
      read: () => bridge.call<string>('clipboard.read', {}),
      markUsed: () => bridge.send('clipboard.markUsed')
    }
    this.shell = {
      openExternal: (url) => bridge.send('app.openExternal', { url }),
      openPath: (path) => bridge.call('app.openPath', { path }),
      showItemInFolder: () => bridge.send('download.showAll'),
      share: (payload) => bridge.call('app.share', payload),
      openAppLinkSettings: () => bridge.send('app.openAppLinkSettings'),
      openPrivateDnsSettings: () => bridge.send('app.openPrivateDnsSettings'),
      openKeyboardSettings: () => bridge.send('app.openKeyboardSettings')
    }
    this.externalProtocols = {
      respond: (requestId, allow) => bridge.send('externalProtocol.respond', { requestId, allow })
    }
    // A body over Kotlin's inline limit (a filter list, a Safe Browsing feed) does not come back
    // JSON-quoted in the reply but as a file the chrome fetches by token (`BootHandoff.readBody`).
    this.net = {
      fetchText: async (url, options) => {
        const result = await bridge.call<{
          ok: boolean
          status?: number
          text: string
          headers?: Record<string, string>
          /** The spilled body, when there is one; `text` is empty then. */
          body?: SpilledBody
        }>('net.fetch', {
          url,
          headers: options.headers ?? {},
          timeoutMs: options.timeoutMs ?? 0,
          // Kotlin stops reading there and fails the fetch (`readBody`'s cap); 0 is its own limit.
          maxBytes: options.maxBytes ?? 0,
          method: options.method ?? 'GET',
          body: options.method === 'POST' ? (options.body ?? '') : null
        })
        let text = result.text
        if (result.body) {
          const release = (token: string): void => bridge.send('net.release', { token })
          if (options.signal?.aborted) release(result.body.token)
          else text = await readSpilledBody(result.body, (u, init) => fetch(u, init), release)
        }
        if (options.signal?.aborted) throw new Error('aborted')
        return {
          ok: result.ok,
          status: result.status ?? (result.ok ? 200 : 0),
          text,
          headers: result.headers ?? {}
        }
      }
    }
    // Kotlin owns the transfers (`Downloads.kt`); records and decisions stay in the core.
    const describe = (item: DownloadItem): Record<string, string | number | boolean> => ({
      id: item.id,
      url: item.url,
      referrer: item.referrer,
      savePath: item.savePath,
      filename: item.filename,
      finalName: item.finalName,
      mimeType: item.mimeType,
      totalBytes: item.totalBytes,
      etag: item.etag,
      lastModified: item.lastModified,
      containerId: item.containerId,
      private: item.private
    })
    this.downloads = {
      // The downloader retries a network failure itself (Chromium's automatic resume, 2 / 4 / 8 s)
      // and announces each attempt; the core schedules none so nothing is retried twice.
      autoResume: 'host',
      pause: (id) => bridge.send('download.pause', { id }),
      resume: (item) => bridge.send('download.resume', describe(item)),
      cancel: (id) => bridge.send('download.cancel', { id }),
      retry: (item) => bridge.send('download.retry', describe(item)),
      // The downloader's own notification announces the finished file, so the setting rides along.
      release: (item, options) =>
        bridge.call<{ savePath: string; finalName: string } | null>('download.release', {
          ...describe(item),
          notify: options.notify
        }),
      deletePartial: (item) => bridge.call('download.discard', describe(item)),
      // Kotlin resolves the recorded location (a MediaStore or SAF `content:` uri, or a path).
      exists: (item) => bridge.call<boolean>('download.exists', { savePath: item.savePath }),
      deleteFile: async (item) => {
        const result = await bridge.call<string>('download.deleteFile', {
          savePath: item.savePath
        })
        return result === 'deleted' || result === 'missing' ? result : 'failed'
      },
      open: (item) =>
        bridge.call('download.open', {
          id: item.id,
          savePath: item.savePath,
          mimeType: item.mimeType
        }),
      // The PDF viewer's "Open with" (the system chooser, every app that takes the file) and
      // its share sheet, with the file itself.
      openWith: (item) =>
        bridge.call('download.openWith', {
          id: item.id,
          savePath: item.savePath,
          mimeType: item.mimeType
        }),
      share: (item) =>
        bridge.call('download.share', {
          id: item.id,
          savePath: item.savePath,
          mimeType: item.mimeType,
          name: item.finalName || item.filename
        }),
      showInFolder: () => bridge.send('download.showAll'),
      chooseDirectory: () => bridge.call<string | null>('download.chooseDirectory')
    }
    this.sessions = {
      clearContainerData: (containerId) => bridge.call('profile.clear', { containerId }),
      clearPrivate: () => bridge.call('profile.clear', { containerId: PRIVATE_CONTAINER_ID }),
      clearAuthCache: () => bridge.call('security.forgetSession', {}),
      // The WebView decides certificate errors on its own side: the core's exception is mirrored
      // to Kotlin (`Security.certificateExceptions`) before the address is asked for again.
      allowCertificate: (containerId, url, fingerprint) =>
        bridge.call('security.allowCertificate', { containerId, url, fingerprint }),
      clearBrowsingData: (containerIds, kinds) =>
        bridge.call('profile.clearBrowsingData', { containerIds, kinds }),
      browsingDataCounts: (containerIds) =>
        bridge.call<EngineDataCounts>('profile.browsingDataCounts', { containerIds })
    }
    this.app = {
      quit: () => bridge.send('app.quit'),
      relaunch: () => bridge.send('app.quit'),
      lastWindowClosed: () => undefined,
      // Kotlin flips the launcher alias that carries this colour (LauncherIcon.kt).
      setAppIcon: (id) => bridge.send('app.setIcon', { id }),
      // Kotlin reads the browser role (RoleManager on Android 10+, the http handler before that).
      isDefaultBrowser: () => bridge.call<boolean | null>('app.isDefaultBrowser'),
      // Resolves when the role dialog / default-apps screen hands control back to the app.
      requestDefaultBrowser: () => bridge.call<boolean | null>('app.requestDefaultBrowser')
    }
    this.shortcuts = {
      pin: (request) => bridge.call<boolean>('shortcut.pin', request)
    }
    // Kotlin asks for the microphone and runs the recogniser (`Voice.kt`); its reports come back
    // as `voice.event`s and go to the window for the listening sheet.
    this.voice = {
      start: () => bridge.call<VoiceStartOutcome>('voice.start'),
      cancel: () => bridge.send('voice.cancel'),
      openSettings: () => bridge.send('voice.openSettings')
    }
    // Kotlin's text-to-speech (`ReadAloud.kt`) is the core's `SpeechHost`: one utterance per
    // `speak` (the engine's queue flushed) or `prepare` (queued behind the current one), its
    // `onStart` / `onRangeStart` / `onDone` / `onError` back as `speech.event`s. No `pause`: the
    // core stops and restarts the sentence. `speech.voices` initialises the engine on first use.
    // Built only where boot found an engine: the core reads the host's presence as read aloud's
    // availability, and a device without one (a build without Google's engine) shows no entry.
    if (this.capabilities.readAloud) {
      this.speech = {
        voices: () => bridge.call<ReadAloudVoice[]>('speech.voices'),
        onVoicesChanged: (listener) => {
          this.voicesListeners.push(listener)
        },
        speak: (utteranceId, text, options) =>
          bridge.send('speech.speak', { utteranceId, text, ...options, queue: 'flush' }),
        prepare: (utteranceId, text, options) =>
          bridge.send('speech.speak', { utteranceId, text, ...options, queue: 'add' }),
        stop: () => bridge.send('speech.stop'),
        onEvent: (listener) => {
          this.speechListeners.push(listener)
        }
      }
    }
    this.thumbnails = {
      configure: (width) => bridge.send('thumbnail.configure', { width }),
      load: (tabId, url) => bridge.call<ThumbnailPicture | null>('thumbnail.load', { tabId, url }),
      drop: (tabId, url) =>
        bridge.send('thumbnail.drop', url === undefined ? { tabId } : { tabId, url }),
      sweep: (keep) => bridge.send('thumbnail.sweep', { keep })
    }
    // Kotlin asks for the camera, opens it and decodes (`QrScan.kt`); its reports come back as
    // `qr.event`s and go to the window for the scan sheet.
    this.qrScan = {
      start: () => bridge.call<QrStartOutcome>('qr.start'),
      cancel: () => bridge.send('qr.cancel'),
      layout: (slot) => bridge.send('qr.layout', slot),
      setTorch: (on) => bridge.send('qr.setTorch', { on }),
      openSettings: () => bridge.send('qr.openSettings')
    }
    // The OS media controls (`MediaSessions.kt`): a MediaSessionCompat behind the media-style
    // notification, the lock screen and the headset buttons, fed with the session the core
    // resolves; the window's picture-in-picture for a video (`PictureInPicture.kt`).
    this.mediaSession = {
      update: (session) => bridge.send('media.update', { session }),
      enterPictureInPicture: (session) => bridge.call<boolean>('media.pip', { session })
    }
    // Web Notifications of the pages (`WebNotifications.kt`): one channel per site on the shade.
    this.webNotifications = {
      show: (request) => bridge.call<boolean>('notification.show', request),
      close: (id) => bridge.send('notification.close', { id }),
      forgetOrigin: (origin) => bridge.send('notification.forgetOrigin', { origin }),
      ensureAllowed: () => bridge.call<boolean>('notification.ensureAllowed')
    }
    this.privateSession = {
      setOpenTabs: (count) => bridge.send('private.setOpenTabs', { count })
    }
    // The window as the host last measured it; the bus keeps it for the chrome, which
    // subscribes once React has rendered (`InProcessEvents`, the sticky replay).
    this.events.send('insets', windowInsetsOf(boot.insets))
  }

  bind(browser: Browser): void {
    this.browser = browser
    this.views.pages.reader = (id) => browser.reader.pageHtml(id)
    this.views.pages.image = (id) => browser.sharedImage(id)
    this.views.pages.pdf = (id) => browser.pdf.document(id)
    if (this.bootEnvironment) browser.pageControls.setEnvironment(this.bootEnvironment)
  }

  createAgentTransport(): AgentTransport {
    return this.agentTransport
  }

  createUpdateHost(): UpdateHost {
    return this.updateHost
  }

  /**
   * The extension store (`extensionHost.ts`) with the runtime (`extensionRuntime.ts`) behind it:
   * the store installs from the stores and from files into `files/zen/extensions`, keeps the
   * registry and updates; the runtime runs what the store hands over. Without an install root
   * (the preview host) the built-in stand-in answers, and the capability above keeps the UI away.
   */
  createExtensions(browser: Browser): ExtensionHost {
    if (this.extensionsRoot === null) return new NoExtensions(browser)
    const io = new AndroidExtensionStoreIo(this.bridge, this.extensionsRoot)
    const runtime = new AndroidExtensionRuntime(this.bridge, browser, () => this.window)
    this.extensionRuntime = runtime
    this.extensions = new AndroidExtensionsWithRuntime(browser, io, runtime)
    return this.extensions
  }

  /** Mozilla's Readability, bundled with the chrome. */
  readabilitySource(file: 'Readability.js' | 'Readability-readerable.js'): string {
    return file === 'Readability.js' ? readabilityJs : readabilityReaderableJs
  }

  /** The app's single window (created by `Browser.start`). */
  get window(): ZenWindow {
    if (!this.zenWindow) throw new Error('Browser not started')
    return this.zenWindow
  }

  // ---------------------------------------------------------------------------
  // Kotlin → JS
  // ---------------------------------------------------------------------------

  viewEvent<K extends keyof ViewEventPayloads>(
    tabId: string,
    name: K,
    payload: ViewEventPayloads[K]
  ): void {
    const view = this.views.get(tabId)
    if (!view) return
    view.dispatch(name, payload)
    // After the core, so `tabs.onUpdated` carries the tab as the core now sees it.
    this.extensionRuntime?.onViewEvent(tabId, name, payload)
    if (name === 'destroyed') this.views.forget(tabId)
  }

  /**
   * Zenium's items for the floating toolbar over a page's selected text (`TabWebView.kt` asks
   * as the system's action mode comes up, and again as the selection changes): ids and titles
   * in order, from the one list the page context menu draws from (`Menus.selectionToolbar`).
   */
  selectionMenu(tabId: string, request: { text?: unknown }): SelectionToolbarItem[] {
    const text = typeof request.text === 'string' ? request.text : ''
    return this.browser.menus.selectionToolbar(tabId, text)
  }

  /** A physical key pressed while a page WebView had focus (already matched by Kotlin). */
  viewKey(tabId: string | null, input: KeyEventInput): boolean {
    if (tabId === null) return this.browser.keys.handle(input, null, this.window)
    const view = this.views.get(tabId)
    return view ? view.key(input) : this.browser.keys.handle(input, null, this.window)
  }

  hostEvent<K extends keyof HostEventPayloads>(name: K, payload: HostEventPayloads[K]): void {
    const { browser } = this
    switch (name) {
      case 'insets':
        this.events.send('insets', windowInsetsOf(payload))
        return
      case 'view.drawn':
        this.events.send('view.drawn', payload as HostEventPayloads['view.drawn'])
        return
      case 'view.sized':
        this.events.send('view.sized', payload as HostEventPayloads['view.sized'])
        return
      case 'thumbnail.captured':
        this.events.send('thumbnail.captured', payload as HostEventPayloads['thumbnail.captured'])
        return
      case 'historyChanged': {
        const p = payload as Partial<HostEventPayloads['historyChanged']>
        if (typeof p.tabId === 'string') this.viewEvent(p.tabId, 'historyChanged', p as HostHistory)
        return
      }
      case 'environment':
        browser.pageControls.setEnvironment(payload as HostEventPayloads['environment'])
        return
      case 'focus': {
        const { focused } = payload as HostEventPayloads['focus']
        // The Activity resumed or paused: the extension update schedule runs only while it is up.
        this.extensions?.setForeground(focused)
        // The activity resumed: a gesture cut short by whatever was in front (a pointer that
        // never lifted for the chrome) is ended by whoever holds it (`zen-resume`).
        if (focused) window.dispatchEvent(new Event('zen-resume'))
        // Back from the system settings, the autofill service may be another one (or none).
        if (focused) this.autofill.refresh()
        // Sync polls only in front; a resume is its cue to look at the folder again.
        this.sync.signal.setFocused(focused)
        if (!this.windowHost) return
        this.windowHost.focused = focused
        if (focused) this.window.onFocused()
        else this.window.onWindowStateChanged()
        return
      }
      case 'fullscreen': {
        const { fullscreen } = payload as HostEventPayloads['fullscreen']
        if (!this.windowHost) return
        this.windowHost.fullscreen = fullscreen
        this.window.onWindowStateChanged()
        return
      }
      case 'openUrl':
        browser.openExternalUrl((payload as HostEventPayloads['openUrl']).url, this.window, {
          fromIntent: true
        })
        return
      case 'intent':
        browser.openSharedIntent(payload as HostEventPayloads['intent'], this.window)
        return
      case 'externalProtocol.request':
        browser.externalProtocols.request(
          payload as HostEventPayloads['externalProtocol.request'],
          this.window
        )
        return
      case 'share.action':
        browser.onShareAction(payload as HostEventPayloads['share.action'], this.window)
        return
      case 'selection.action': {
        // The host's payload, checked before it names an action: the text is a page's.
        const action = payload as Partial<HostEventPayloads['selection.action']>
        if (
          typeof action.tabId !== 'string' ||
          typeof action.id !== 'string' ||
          typeof action.text !== 'string'
        )
          return
        const origin =
          typeof action.originX === 'number' && typeof action.originY === 'number'
            ? { x: action.originX, y: action.originY }
            : undefined
        browser.menus.runSelectionAction(action.tabId, action.id, action.text, origin)
        return
      }
      case 'pause':
        browser.flushSync()
        return
      case 'resume':
        // Re-apply the last layout, so every page view is placed and shown for the window the
        // chrome returns to; Kotlin asks its WebViews for a fresh frame alongside.
        this.zenWindow?.relayout()
        return
      case 'memoryPressure': {
        const p = payload as HostEventPayloads['memoryPressure']
        browser.tabs.unloadForMemoryPressure(p.level === 'critical' ? 'critical' : 'low')
        return
      }
      case 'download.started': {
        const p = payload as HostEventPayloads['download.started']
        const containerId = p.containerId || DEFAULT_CONTAINER_ID
        const record = browser.downloads.begin({
          url: p.url,
          referrer: p.referrer,
          filename: p.filename,
          totalBytes: p.totalBytes,
          mimeType: p.mimeType,
          savePath: p.savePath,
          sourceTabId: p.sourceTabId,
          userGesture: null,
          canResume: p.canResume,
          containerId,
          private: containerId === PRIVATE_CONTAINER_ID,
          resumes: p.resumes,
          navigation: p.navigation === true,
          disposition:
            p.disposition === 'inline' || p.disposition === 'attachment' ? p.disposition : null
        })
        if (record.state === 'insecure-blocked') {
          // Refused before a byte moved (Chrome's mixed-content rule): the row waits for Keep
          // anyway or Discard, the announced transfer is dropped and reports nothing more.
          this.bridge.send('download.refuse', { token: p.token })
          if (!p.resumes) browser.onDownloadStarted(p.sourceTabId)
          return
        }
        this.downloadTokens.set(p.token, record.id)
        // Where the file goes: the system save dialog, the folder from Settings, or the default.
        const settings = resolveDownloadSettings(browser.state.settings)
        const destination = settings.askWhereToSave
          ? { mode: 'ask' }
          : settings.directory
            ? { mode: 'folder', folder: settings.directory }
            : { mode: 'default' }
        this.bridge.send('download.bind', {
          token: p.token,
          id: record.id,
          destination,
          private: record.private,
          // Keep anyway was chosen on this row: the downloader's own chain rule stands down.
          insecureAccepted: record.insecureAccepted === true
        })
        if (!p.resumes) browser.onDownloadStarted(p.sourceTabId)
        return
      }
      case 'download.progress': {
        const p = payload as HostEventPayloads['download.progress']
        const id = this.downloadTokens.get(p.token)
        if (id)
          browser.downloads.progress(id, {
            receivedBytes: p.receivedBytes,
            totalBytes: p.totalBytes,
            state: p.state,
            canResume: p.canResume,
            etag: p.etag,
            lastModified: p.lastModified,
            savePath: p.savePath || undefined,
            finalName: p.finalName || undefined,
            mimeType: p.mimeType || undefined,
            error: p.state === 'interrupted' && p.error ? interruptReasonFrom(p.error) : undefined,
            autoResumeAt:
              p.state === 'interrupted' && p.autoResumeAt && p.autoResumeAt > 0
                ? p.autoResumeAt
                : undefined
          })
        return
      }
      case 'download.done': {
        const p = payload as HostEventPayloads['download.done']
        const id = this.downloadTokens.get(p.token)
        this.downloadTokens.delete(p.token)
        if (!id) return
        if (p.state === 'cancelled' && p.error === 'dismissed') {
          // The save dialog was dismissed: no download happened, so no record either.
          browser.downloads.remove(id)
          return
        }
        browser.downloads.finish(id, p.state, {
          savePath: p.savePath,
          finalName: p.finalName,
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes,
          canResume: p.canResume,
          error: p.state === 'interrupted' && p.error ? interruptReasonFrom(p.error) : undefined,
          mimeType: p.mimeType || undefined
        })
        return
      }
      case 'download.action': {
        const p = payload as HostEventPayloads['download.action']
        if (p.op === 'pause') browser.downloads.pause(p.id)
        else if (p.op === 'resume') browser.downloads.resume(p.id)
        else browser.downloads.cancel(p.id)
        return
      }
      case 'permission.request': {
        const p = payload as HostEventPayloads['permission.request']
        void browser.permissions
          .decide(p.permission, p.url, { tabId: p.tabId, mediaTypes: p.mediaTypes })
          .then((allow) =>
            this.bridge.send('permission.respond', { requestId: p.requestId, allow })
          )
        return
      }
      case 'auth.request': {
        const p = payload as HostEventPayloads['auth.request']
        let port = 0
        let secure = false
        try {
          const u = new URL(p.url)
          secure = u.protocol === 'https:'
          port = u.port ? Number(u.port) : secure ? 443 : 80
        } catch {
          /* the host string is all we show */
        }
        void browser.security
          .httpAuth(
            { host: p.host, port, realm: p.realm, scheme: '', isProxy: false, secure },
            p.tabId
          )
          .then((credentials) =>
            this.bridge.send('auth.respond', {
              requestId: p.requestId,
              username: credentials?.username ?? null,
              password: credentials?.password ?? null
            })
          )
        return
      }
      case 'agent.request':
        this.agentTransport.handle(payload as HostEventPayloads['agent.request'])
        return
      case 'update.progress':
        this.updateHost.onProgress(payload as HostEventPayloads['update.progress'])
        return
      case 'extension.sideload':
        // Without a store (the preview host) the packages stay queued in Kotlin's cache and are
        // swept with the next start.
        if (this.extensions) void this.extensions.installPending(this.window)
        return
      case 'ext.message':
        this.extensionRuntime?.onMessage(payload as HostEventPayloads['ext.message'])
        return
      case 'ext.gone':
        this.extensionRuntime?.onGone((payload as HostEventPayloads['ext.gone']).eps)
        return
      case 'ext.popupClosed':
        this.extensionRuntime?.onPopupClosed()
        return
      case 'ext.request':
        this.extensionRuntime?.onRequest(payload as HostEventPayloads['ext.request'])
        return
      case 'ext.authView':
        this.extensionRuntime?.onAuthView(payload)
        return
      case 'ext.notification':
        this.extensionRuntime?.onNotification(payload)
        return
      case 'translate.progress':
        this.translate.onProgress(payload as HostEventPayloads['translate.progress'])
        return
      case 'shortcut.pinned':
        browser.webApps.onPinned((payload as HostEventPayloads['shortcut.pinned']).id)
        return
      case 'voice.event':
        browser.emit('voice.event', payload as HostEventPayloads['voice.event'], this.window)
        return
      case 'qr.event':
        browser.emit('qr.event', payload as HostEventPayloads['qr.event'], this.window)
        return
      case 'speech.event': {
        const { utteranceId, ...event } = payload as HostEventPayloads['speech.event']
        if (typeof utteranceId !== 'string') return
        for (const listener of this.speechListeners) listener(utteranceId, event)
        return
      }
      case 'speech.voicesChanged':
        for (const listener of this.voicesListeners) listener()
        return
      case 'media.action': {
        const p = payload as Partial<HostEventPayloads['media.action']>
        if (typeof p.action !== 'string') return
        browser.mediaSession.act(typeof p.tabId === 'string' ? p.tabId : null, p.action, {
          seekTime: typeof p.seekTime === 'number' ? p.seekTime : undefined,
          seekOffset: typeof p.seekOffset === 'number' ? p.seekOffset : undefined
        })
        return
      }
      case 'media.pip': {
        const p = payload as Partial<HostEventPayloads['media.pip']>
        if (typeof p.tabId === 'string')
          browser.mediaSession.onPictureInPicture(p.tabId, p.active === true)
        return
      }
      case 'media.reveal': {
        const p = payload as Partial<HostEventPayloads['media.reveal']>
        if (typeof p.tabId === 'string') browser.revealTab(p.tabId)
        return
      }
      case 'notification.event': {
        const p = payload as Partial<HostEventPayloads['notification.event']>
        if (
          typeof p.id === 'string' &&
          (p.event === 'click' || p.event === 'close' || p.event === 'replaced')
        )
          browser.webNotifications.onHostEvent(
            p.id,
            p.event,
            typeof p.url === 'string' ? p.url : undefined
          )
        return
      }
      case 'notification.blocked': {
        const p = payload as Partial<HostEventPayloads['notification.blocked']>
        if (typeof p.origin === 'string') browser.permissions.set('notifications', p.origin, 'deny')
        return
      }
      case 'private.closeAll':
        browser.tabs.closePrivateTabs(this.window)
        return
      case 'fullscreen.entered': {
        const p = payload as Partial<HostEventPayloads['fullscreen.entered']>
        if (typeof p.tabId !== 'string') return
        const tabId = p.tabId
        // The chrome is under the fullscreen layer: the hint is drawn in the page's top layer
        // (`shared/pageHint.ts`), as the desktop's fullscreen hints are.
        onFullscreenEntered({
          settings: () => browser.state.settings,
          dark: () => browser.darkScheme(),
          markShown: () => browser.updateSettings({ fullscreenHintDone: true }, this.window),
          post: (hint) =>
            this.bridge.send('view.postMessage', { tabId, message: { type: 'hint', hint } })
        })
        return
      }
      case 'view.adopt': {
        const p = payload as HostEventPayloads['view.adopt']
        // Kotlin created the WebView for a popup. Pick the tab id first and bind it before the
        // core issues any placement calls for the new view (bridge calls are delivered in order).
        const tabId = newId('tab')
        const view = this.views.registerAdopted(tabId)
        this.bridge.send('view.bind', { viewId: p.viewId, tabId })
        const { events } = browser.tabs.adoptView(
          view,
          { tabId, parentTabId: p.parentTabId, active: p.active },
          this.window
        )
        view.events = events
        return
      }
    }
  }
}
