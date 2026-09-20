import type { PageHint } from './fullscreenHint'
import { installHint } from './pageHint'
import { getDomain } from './url'
import {
  INTERSTITIAL_ACTIONS,
  INTERSTITIAL_MESSAGE_KEY,
  type InterstitialAction,
  type InterstitialMessage
} from './interstitial'
import { MANIFEST_FIELDS, type RawWebAppManifest } from './webApp'
import type { MediaReport, MediaSessionHostMessage } from './mediaSession'
import type { NotificationHostMessage, NotificationPageRequest } from './notifications'
import { installMediaTracking } from './mediaSessionScript'
import { READER_MESSAGE_KEY } from './reader'
import { pdfReportOf, pdfReportTokenOf, type PdfViewerReport } from './pdfViewerProtocol'
import { INSTALL_PROMPT_EVENTS, type InstallPromptShimEvents } from './installPrompt'
import type { ReadAloudExtraction, ReadAloudHostMessage } from './readAloud'
import { installReadAloud } from './readAloudScript'

/**
 * Runs inside every web page. It implements the click behaviours Zen adds on top of the engine:
 *  - Glance: modifier+click on a link previews it in a floating overlay.
 *  - Pinned/Essential tabs: plain clicks on third-party links open in their own tab.
 *  - Media: reports play/pause so hosts without native audio events can show the media player.
 *  - Boosts "zap element": pick an element to hide it on this site for good.
 *  - Fullscreen hints: the browser's "is now full screen" toast, drawn over the page.
 *  - Web apps: posts the page's manifest and polyfills `beforeinstallprompt` / `appinstalled`
 *    on hosts that pin pages to the Home screen.
 *
 * The transport is injected: Electron's preload uses `ipcRenderer`, Android a `WebMessageListener`.
 * No page-visible globals are created by this module itself.
 */
export interface PageScriptFlags {
  glanceEnabled: boolean
  glanceTrigger: 'alt' | 'ctrl' | 'shift'
  thirdParty: 'new-tab' | 'glance' | 'same-tab' | null
}

export interface PageScriptMessage {
  type:
    | 'glance'
    | 'open-tab'
    | 'navigate'
    | 'media'
    | 'zap'
    | 'activation'
    | 'popup-blocked'
    | 'interstitial'
    | 'focus'
    | 'webapp'
    | 'notification'
    | 'reader'
    | 'pdf'
    | 'opensearch'
    | 'readAloud'
    | 'fullscreen'
  url?: string
  /** `opensearch`: the link's `title`, the engine's name when its description has none. */
  title?: string
  x?: number
  y?: number
  background?: boolean
  playing?: boolean
  /** `media`: the full report on hosts that track media through the script (`trackMedia`). */
  media?: MediaReport
  /** `zap`: CSS selector of the element the user picked. */
  selector?: string
  /** `interstitial`: the button pressed on a Zenium warning page (`zen://error`). */
  action?: InterstitialAction
  /** `webapp`: see `PageMessage` in the core. */
  webapp?: 'manifest' | 'deferred' | 'prompt'
  manifestUrl?: string
  manifest?: RawWebAppManifest | null
  /** `notification`: the `Notification` polyfill's request (see `shared/notifications`). */
  notification?: NotificationPageRequest
  /** `reader`: the text preferences a `zen://reader` page's toolbar changed (a partial). */
  reader?: unknown
  /** `pdf`: the PDF viewer document's report (`pdfViewerProtocol.ts`). */
  pdf?: PdfViewerReport
  /** `pdf`: the document's token posted beside the report, for the core to check. */
  token?: string
  /** `readAloud`: the answer to a `readAloud.extract` request (`readAloudScript.ts`). */
  readAloud?: ReadAloudExtraction
  /**
   * `fullscreen` (hosts with `reportFullscreen`): the document has a fullscreen element
   * (`active`), and when it is a `<video>` or holds one, the video's natural size – 0 × 0 while
   * the size is not known (no video, or its metadata still to come).
   */
  active?: boolean
  videoWidth?: number
  videoHeight?: number
}

/** Browser → page messages for the web-app polyfill (mirrors `PageHostMessage` in the core). */
export interface WebAppHostMessage {
  type: 'webapp'
  action: 'installable' | 'result' | 'installed'
  outcome?: 'accepted' | 'dismissed'
}

/**
 * Browser → page messages the script answers: the web-app polyfill, the media session's
 * actions, the notification polyfill's answers and read aloud's requests (mirrors
 * `PageHostMessage` in the core).
 */
export type PageScriptHostMessage =
  WebAppHostMessage | MediaSessionHostMessage | NotificationHostMessage | ReadAloudHostMessage

/**
 * The IPC channel the browser posts `PageHostMessage`s into a page on (Electron's
 * `TabView.postToPage` → `preload/page.ts`): the web-app install events, media controls, share
 * results and geolocation answers, told apart by `type`.
 */
export const PAGE_HOST_CHANNEL = 'zen:page-host'

export interface PageScriptTransport {
  send(message: PageScriptMessage): void
  onFlags(listener: (flags: PageScriptFlags) => void): void
  /** Boost zap mode toggled by the browser. */
  onZap?(listener: (on: boolean) => void): void
  /**
   * A fullscreen hint to draw over the page (null takes the current one down). Hosts whose
   * chrome can stand over a fullscreen page draw it themselves and leave this out.
   */
  onHint?(listener: (hint: PageHint | null) => void): void
  /** Hosts without native audio-state events ask for media tracking. */
  trackMedia?: boolean
  /**
   * Hosts whose engine blocks pop-ups itself (the Android WebView) learn which URLs it refused:
   * the script runs in the page's world there and can watch `window.open` return null.
   */
  reportBlockedPopups?: boolean
  /**
   * Hosts that pin pages to the Home screen: the script posts the page's manifest and turns the
   * host's `installable` / `result` / `installed` messages into the standard install events.
   */
  onWebApp?(listener: (message: WebAppHostMessage) => void): void
  /**
   * Hosts that carry the media session to the OS controls (with `trackMedia`): the script
   * polyfills `navigator.mediaSession` when the engine lacks it and runs the host's actions –
   * the page's handlers where it registered any, the playing element otherwise.
   */
  onMediaSession?(listener: (message: MediaSessionHostMessage) => void): void
  /**
   * Hosts whose screen turns with a fullscreen video (Android, as Chrome's does): the script
   * reports every `fullscreenchange` with the fullscreen video's natural size
   * (`installFullscreenReporter`).
   */
  reportFullscreen?: boolean
  /**
   * Hosts that offer a page's own search engine (Chrome for Android's "Recently visited" engines):
   * the script posts the address of the first `<link rel="search"
   * type="application/opensearchdescription+xml">` once per document; the browser fetches and
   * parses the description itself (`shared/search`).
   */
  discoverSearchEngines?: boolean
  /**
   * Hosts whose page script runs in an isolated world (Electron): run
   * `shared/installPrompt`'s shim in the page's main world, where the `beforeinstallprompt`
   * event must be born for the page to call `prompt()` on it. Without it the polyfill runs
   * inline (Android, whose script is in the page's world already).
   */
  installInstallPromptShim?(events: InstallPromptShimEvents): void
  /**
   * Hosts with a speech engine (`capabilities.readAloud`): the script answers the browser's
   * `readAloud.extract` request with the page's text as blocks and paints its
   * `readAloud.highlight` messages (`readAloudScript.ts`).
   */
  onReadAloud?(listener: (message: ReadAloudHostMessage) => void): void
}

/** Keys that never count as a gesture in Chromium's user-activation model. */
const NON_ACTIVATING_KEYS = new Set(['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'AltGraph'])

/** Consecutive activation reports closer than this are dropped (the clock only needs freshness). */
const ACTIVATION_REPORT_INTERVAL_MS = 250

/** Whether a DOM event grants user activation (trusted press, tap or non-modifier key). */
export function isActivatingEvent(e: Event): boolean {
  if (!e.isTrusted) return false
  switch (e.type) {
    case 'pointerdown':
    case 'mousedown':
    case 'touchend':
      return true
    case 'keydown':
      return !NON_ACTIVATING_KEYS.has((e as KeyboardEvent).key)
    default:
      return false
  }
}

export const DEFAULT_PAGE_FLAGS: PageScriptFlags = {
  glanceEnabled: true,
  glanceTrigger: 'alt',
  thirdParty: null
}

export function installPageScript(transport: PageScriptTransport): void {
  let flags: PageScriptFlags = { ...DEFAULT_PAGE_FLAGS }
  transport.onFlags((next) => {
    flags = next
  })

  const findAnchor = (target: EventTarget | null): HTMLAnchorElement | null => {
    let el = target as Element | null
    while (el && el !== document.documentElement) {
      if (el instanceof HTMLAnchorElement && el.href) return el
      el = el.parentElement
    }
    return null
  }

  const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url)

  const triggerHeld = (e: MouseEvent): boolean => {
    switch (flags.glanceTrigger) {
      case 'alt':
        return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
      case 'ctrl':
        return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
      case 'shift':
        return e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
    }
  }

  const zap = installZap(transport)
  installActivationReporter(transport)
  if (transport.reportBlockedPopups) installPopupObserver(transport)
  installInterstitialRelay(transport)
  installReaderRelay(transport)
  installPdfViewerRelay(transport)
  if (transport.onHint) installHint(transport.onHint.bind(transport))
  if (transport.onWebApp) installWebApp(transport)
  if (transport.discoverSearchEngines) installOpenSearch(transport)
  if (transport.onReadAloud)
    installReadAloud({
      send: transport.send.bind(transport),
      onReadAloud: transport.onReadAloud.bind(transport)
    })
  if (transport.reportFullscreen) installFullscreenReporter(transport)

  window.addEventListener(
    'click',
    (e) => {
      if (zap.active()) return
      if (e.defaultPrevented || e.button !== 0) return
      const anchor = findAnchor(e.target)
      if (!anchor) return
      const href = anchor.href
      if (!isHttpUrl(href)) return
      // Don't hijack in-page fragment navigation or explicit download links.
      if (anchor.hasAttribute('download')) return
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed && selection.toString().trim()) return

      const x = e.clientX / Math.max(1, window.innerWidth)
      const y = e.clientY / Math.max(1, window.innerHeight)
      if (flags.glanceEnabled && triggerHeld(e)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        transport.send({ type: 'glance', url: href, x, y })
        return
      }

      const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
      if (plain && flags.thirdParty && flags.thirdParty !== 'same-tab') {
        const target = anchor.target
        if (target && target !== '_self' && target !== '_top' && target !== '_parent') return
        if (getDomain(href) !== getDomain(location.href)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          transport.send({
            type: flags.thirdParty === 'glance' ? 'glance' : 'open-tab',
            url: href,
            x,
            y
          })
        }
      }
    },
    true
  )

  if (transport.trackMedia) installMediaTracking(transport)
}

// ---------------------------------------------------------------------------
// Pop-up blocker: user activation and blocked window.open calls
// ---------------------------------------------------------------------------

/**
 * Tells the browser when the user interacts with the page, so a `window.open` that follows can be
 * told apart from one the page fired on its own. Trusted events only; `navigator.userActivation`
 * (where the engine has it) is consulted as well so a gesture the listeners missed still counts.
 *
 * Exported for frames: a click inside a cross-origin iframe reaches that frame's own widget, which
 * the desktop host never hears about (Electron reports input for the top document's widget only),
 * so the frame reports its gestures itself – "Sign in with Google" lives in such an iframe and
 * opens its pop-up from there.
 */
export function installActivationReporter(transport: Pick<PageScriptTransport, 'send'>): void {
  let lastSent = -Infinity
  const report = (): void => {
    const now = Date.now()
    if (now - lastSent < ACTIVATION_REPORT_INTERVAL_MS) return
    lastSent = now
    transport.send({ type: 'activation' })
  }
  const onEvent = (e: Event): void => {
    if (isActivatingEvent(e)) report()
  }
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'touchend'])
    window.addEventListener(type, onEvent, { capture: true, passive: true })
  // Focus changes ride on gestures too (a tap that lands on a control); consult the engine.
  window.addEventListener(
    'focusin',
    () => {
      const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } })
        .userActivation
      if (ua?.isActive) report()
    },
    true
  )
}

// ---------------------------------------------------------------------------
// Fullscreen video: the size the host turns the screen by
// ---------------------------------------------------------------------------

/** The document's fullscreen element, under either name the engines have given it. */
function fullscreenElementOf(doc: Document): Element | null {
  return (
    doc.fullscreenElement ??
    (doc as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ??
    null
  )
}

/**
 * The video a fullscreen element shows: the element itself, or – a player's wrapper in
 * fullscreen, YouTube's way – the first video inside it with a size, else the first at all.
 * Null for an element without one (a game's canvas, a slide deck), which turns nothing.
 */
export function fullscreenVideoOf(element: Element): HTMLVideoElement | null {
  if (typeof HTMLVideoElement === 'undefined') return null
  if (element instanceof HTMLVideoElement) return element
  const videos = [...element.querySelectorAll('video')].filter(
    (v): v is HTMLVideoElement => v instanceof HTMLVideoElement
  )
  return videos.find((v) => v.videoWidth > 0) ?? videos[0] ?? null
}

/**
 * Tells the host, at every `fullscreenchange`, whether the document has a fullscreen element
 * and the natural size of the video it shows (0 × 0 for none, or none known yet). The host
 * turns the screen by it: a landscape video takes Android to landscape as Chrome's does
 * (MED-01). A video in fullscreen before its metadata arrived reports again at
 * `loadedmetadata`, as Chrome's orientation lock waits for the size before it locks. The
 * engine's own `onShowCustomView` comes before the page's event, so the host pairs the two.
 */
export function installFullscreenReporter(transport: Pick<PageScriptTransport, 'send'>): void {
  let awaitingMetadata: HTMLVideoElement | null = null
  const send = (active: boolean, video: HTMLVideoElement | null): void =>
    transport.send({
      type: 'fullscreen',
      active,
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0
    })
  const onMetadata = (e: Event): void => {
    const video = awaitingMetadata
    awaitingMetadata = null
    if (!video || e.target !== video) return
    const element = fullscreenElementOf(document)
    if (element && fullscreenVideoOf(element) === video) send(true, video)
  }
  const report = (): void => {
    if (awaitingMetadata) {
      awaitingMetadata.removeEventListener('loadedmetadata', onMetadata)
      awaitingMetadata = null
    }
    const element = fullscreenElementOf(document)
    if (!element) {
      send(false, null)
      return
    }
    const video = fullscreenVideoOf(element)
    send(true, video)
    if (video && video.videoWidth === 0) {
      awaitingMetadata = video
      video.addEventListener('loadedmetadata', onMetadata, { once: true })
    }
  }
  document.addEventListener('fullscreenchange', report, true)
  document.addEventListener('webkitfullscreenchange', report, true)
}

/**
 * Watches `window.open`: when the engine returns null while the page has no user activation the
 * pop-up was blocked, and the browser lists it so the user can open it anyway. A null result
 * during activation is a `noopener` window that did open, not a block.
 */
function installPopupObserver(transport: PageScriptTransport): void {
  const nativeOpen = window.open
  const resolve = (url: unknown): string => {
    const text = url === undefined || url === null ? '' : String(url)
    try {
      return new URL(text, document.baseURI).href
    } catch {
      return text
    }
  }
  const observed = function (
    this: Window | undefined,
    url?: string | URL,
    target?: string,
    features?: string
  ): Window | null {
    const result = nativeOpen.call(this ?? window, url, target, features)
    if (result === null) {
      const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } })
        .userActivation
      if (!ua?.isActive) transport.send({ type: 'popup-blocked', url: resolve(url) })
    }
    return result
  }
  try {
    Object.defineProperty(window, 'open', { value: observed, configurable: true, writable: true })
  } catch {
    /* a frozen window object keeps the engine's open; the blocker still blocks */
  }
}

// ---------------------------------------------------------------------------
// Boosts: zap element
// ---------------------------------------------------------------------------

const STABLE_CLASS = /^[a-zA-Z][a-zA-Z0-9_-]{1,40}$/
const UNSTABLE_CLASS = /(^|[-_])(\d{2,}|[a-f0-9]{5,})([-_]|$)|^css-|^sc-|^jsx-|^_/

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(s)
    : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

/**
 * The interstitials (`zen://error?kind=…`) post their button presses on the window; only a
 * document of Zenium's own scheme may relay them, so a web page cannot except itself from Safe
 * Browsing or HTTPS-only mode by posting the same message. The core still checks the URL against
 * the block it is holding for the tab. The certificate interstitial is also written into the
 * engine's own error document (`chrome-error:`, what Chromium commits for a failed load; no web
 * content is ever such a document), so that one relays too.
 */
export const INTERSTITIAL_DOCUMENT_PROTOCOLS: readonly string[] = ['zen:', 'chrome-error:']

function installInterstitialRelay(transport: PageScriptTransport): void {
  if (!INTERSTITIAL_DOCUMENT_PROTOCOLS.includes(location.protocol)) return
  const actions = new Set<string>(INTERSTITIAL_ACTIONS)
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return
    const data = e.data as { [INTERSTITIAL_MESSAGE_KEY]?: Partial<InterstitialMessage> } | null
    const message = data && typeof data === 'object' ? data[INTERSTITIAL_MESSAGE_KEY] : undefined
    if (!message || typeof message !== 'object') return
    const { action, url } = message
    if (typeof action !== 'string' || !actions.has(action) || typeof url !== 'string') return
    transport.send({ type: 'interstitial', action: action as InterstitialAction, url })
  })
}

/**
 * The `zen://reader` page posts its toolbar's changes to the text preferences on the window;
 * only a document of Zenium's own scheme may relay them (a web page cannot rewrite the setting).
 * The core validates the patch (`readerPreferencesPatch`) before it saves anything.
 */
function installReaderRelay(transport: PageScriptTransport): void {
  if (location.protocol !== 'zen:') return
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return
    const data = e.data as { [READER_MESSAGE_KEY]?: unknown } | null
    const patch = data && typeof data === 'object' ? data[READER_MESSAGE_KEY] : undefined
    if (!patch || typeof patch !== 'object') return
    transport.send({ type: 'reader', reader: patch })
  })
}

/**
 * The PDF viewer document (`zen://pdf`, `pdfPage.ts`) posts its state on its window, with the
 * document's token beside it, and this relays both. The document runs under the PDF's own URL
 * (`pdfViewerBaseUrl`), an origin no script here can tell from a web page's, so the token is
 * what keeps a page from posing as the viewer to the chrome's PDF controls: the core takes the
 * report only with the token it wrote into that document (`PdfViewerService.onReport`).
 */
function installPdfViewerRelay(transport: PageScriptTransport): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return
    const report = pdfReportOf(e.data)
    if (!report) return
    const token = pdfReportTokenOf(e.data)
    if (token) transport.send({ type: 'pdf', pdf: report, token })
  })
}

/** A selector that matches exactly this element and is likely to survive re-renders. */
export function selectorFor(el: Element): string {
  if (el.id && !/\d{3,}/.test(el.id)) {
    const s = `#${cssEscape(el.id)}`
    if (document.querySelectorAll(s).length === 1) return s
  }
  const parts: string[] = []
  let cur: Element | null = el
  let depth = 0
  while (cur && cur !== document.documentElement && depth < 6) {
    let part = cur.tagName.toLowerCase()
    const classes = [...cur.classList]
      .filter((c) => STABLE_CLASS.test(c) && !UNSTABLE_CLASS.test(c))
      .slice(0, 3)
    if (cur.id && !/\d{3,}/.test(cur.id)) {
      parts.unshift(`#${cssEscape(cur.id)}`)
      break
    }
    if (classes.length) part += classes.map((c) => `.${cssEscape(c)}`).join('')
    else {
      const role = cur.getAttribute('role')
      const label = cur.getAttribute('aria-label')
      if (role) part += `[role="${role.replace(/"/g, '\\"')}"]`
      else if (label && label.length < 40) part += `[aria-label="${label.replace(/"/g, '\\"')}"]`
    }
    const parent = cur.parentElement
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === cur!.tagName)
      if (siblings.length > 1 && !classes.length)
        part += `:nth-of-type(${siblings.indexOf(cur) + 1})`
    }
    parts.unshift(part)
    const candidate = parts.join(' > ')
    if (document.querySelectorAll(candidate).length === 1) return candidate
    cur = parent
    depth++
  }
  return parts.join(' > ')
}

function installZap(transport: PageScriptTransport): { active: () => boolean } {
  let zapping = false
  let highlight: HTMLDivElement | null = null
  let hovered: Element | null = null

  const ensureHighlight = (): HTMLDivElement => {
    if (highlight && highlight.isConnected) return highlight
    highlight = document.createElement('div')
    highlight.setAttribute('aria-hidden', 'true')
    Object.assign(highlight.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483647',
      border: '2px solid #ff4f9a',
      background: 'rgba(255, 79, 154, 0.18)',
      borderRadius: '6px',
      boxShadow: '0 0 0 2px rgba(255,255,255,.6)',
      transition: 'all 60ms ease-out',
      left: '0',
      top: '0',
      width: '0',
      height: '0'
    })
    document.documentElement.appendChild(highlight)
    return highlight
  }

  const onMove = (e: MouseEvent): void => {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || el === highlight || el === document.documentElement || el === document.body) return
    hovered = el
    const r = el.getBoundingClientRect()
    const h = ensureHighlight()
    h.style.left = `${r.left - 2}px`
    h.style.top = `${r.top - 2}px`
    h.style.width = `${r.width + 4}px`
    h.style.height = `${r.height + 4}px`
  }

  const swallow = (e: Event): void => {
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  const stop = (): void => {
    if (!zapping) return
    zapping = false
    document.documentElement.style.cursor = ''
    window.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('pointerdown', onMove, true)
    window.removeEventListener('click', onClick, true)
    window.removeEventListener('mousedown', swallow, true)
    window.removeEventListener('mouseup', swallow, true)
    highlight?.remove()
    highlight = null
    hovered = null
  }

  const onClick = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopImmediatePropagation()
    const el = hovered ?? (document.elementFromPoint(e.clientX, e.clientY) as Element | null)
    if (!el) return
    const selector = selectorFor(el)
    stop()
    transport.send({ type: 'zap', selector })
  }

  const start = (): void => {
    if (zapping) return
    zapping = true
    ensureHighlight()
    document.documentElement.style.cursor = 'crosshair'
    window.addEventListener('mousemove', onMove, true)
    // Touch has no hover: highlight the element under the finger before the click lands.
    window.addEventListener('pointerdown', onMove, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('mousedown', swallow, true)
    window.addEventListener('mouseup', swallow, true)
  }

  transport.onZap?.((on) => (on ? start() : stop()))
  return { active: () => zapping }
}

// ---------------------------------------------------------------------------
// Web apps: manifest probe and the install-prompt polyfill
// ---------------------------------------------------------------------------

/** Manifests bigger than this are not apps but mistakes; the browser ignores them. */
const MAX_MANIFEST_CHARS = 256 * 1024
const MAX_MANIFEST_ICONS = 32
const MAX_MANIFEST_SCREENSHOTS = 8

type InstallOutcome = 'accepted' | 'dismissed'
interface InstallChoice {
  outcome: InstallOutcome
  platform: string
}

/**
 * Only the fields the browser reads leave the page, with the lists capped, so a manifest never
 * carries more across the bridge than the install sheet can show.
 */
export function manifestSubset(json: unknown): RawWebAppManifest | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const source = json as Record<string, unknown>
  const subset: Record<string, unknown> = {}
  for (const key of MANIFEST_FIELDS) {
    if (!(key in source)) continue
    const value = source[key]
    if (key === 'icons' || key === 'screenshots') {
      if (!Array.isArray(value)) continue
      const cap = key === 'icons' ? MAX_MANIFEST_ICONS : MAX_MANIFEST_SCREENSHOTS
      subset[key] = value.slice(0, cap).map((entry) => {
        if (!entry || typeof entry !== 'object') return null
        const e = entry as Record<string, unknown>
        return {
          src: e.src,
          sizes: e.sizes,
          type: e.type,
          purpose: e.purpose,
          form_factor: e.form_factor,
          label: e.label
        }
      })
    } else if (typeof value === 'string') {
      subset[key] = value.slice(0, 2048)
    }
  }
  return subset
}

/** Whether a `<link>`'s `rel` names a manifest (token list, case-insensitive). */
export function isManifestLink(rel: string): boolean {
  return rel
    .toLowerCase()
    .split(/\s+/)
    .some((token) => token === 'manifest')
}

/**
 * Everything here is best effort and must never throw into the page: the probe runs in the top
 * frame of http(s) documents only, the fetch uses the page's own credentials rules (`crossorigin`)
 * and reports the manifest URL alone when the page's CSP blocks it so the host can fetch instead.
 */
function installWebApp(transport: PageScriptTransport): void {
  try {
    if (window !== window.top) return
    if (location.protocol !== 'https:' && location.protocol !== 'http:') return
  } catch {
    return
  }
  // Pages sometimes wrap fetch; the browser's own copy is captured at document start.
  const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null

  let probed = false
  const probe = (): void => {
    if (probed) return
    let link: HTMLLinkElement | null = null
    try {
      for (const candidate of document.querySelectorAll('link[rel]')) {
        const l = candidate as HTMLLinkElement
        if (isManifestLink(l.getAttribute('rel') ?? '') && l.href) {
          link = l
          break
        }
      }
    } catch {
      return
    }
    if (!link) return
    probed = true
    const manifestUrl = link.href
    const useCredentials =
      (link.getAttribute('crossorigin') ?? '').toLowerCase() === 'use-credentials'
    const post = (manifest: RawWebAppManifest | null): void =>
      transport.send({ type: 'webapp', webapp: 'manifest', manifestUrl, manifest })
    if (!nativeFetch) {
      post(null)
      return
    }
    try {
      nativeFetch(manifestUrl, {
        mode: 'cors',
        credentials: useCredentials ? 'include' : 'omit',
        cache: 'default'
      })
        .then((response) => (response.ok ? response.text() : Promise.reject(new Error('status'))))
        .then((text) => {
          if (text.length > MAX_MANIFEST_CHARS) throw new Error('too large')
          post(manifestSubset(JSON.parse(text)))
        })
        .catch(() => post(null))
    } catch {
      post(null)
    }
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', probe, { once: true })
  else probe()
  // Frameworks that inject the link late still get one more look.
  window.addEventListener('load', probe, { once: true })

  // --- beforeinstallprompt / appinstalled --------------------------------------------------------

  if (transport.installInstallPromptShim) {
    // The events live in the page's world (`shared/installPrompt`); this world relays.
    const events = INSTALL_PROMPT_EVENTS
    document.addEventListener(events.request, (e) => {
      const detail = (e as CustomEvent<unknown>).detail
      let kind: unknown = detail
      if (typeof detail === 'string') {
        try {
          kind = (JSON.parse(detail) as { kind?: unknown }).kind
        } catch {
          return
        }
      }
      if (kind === 'prompt' || kind === 'deferred') transport.send({ type: 'webapp', webapp: kind })
    })
    transport.onWebApp?.((message) => {
      document.dispatchEvent(
        new CustomEvent(events.result, {
          detail: JSON.stringify({ action: message.action, outcome: message.outcome })
        })
      )
    })
    try {
      transport.installInstallPromptShim(events)
    } catch {
      /* the main world refused the script; the manifest probe above still serves the menu */
    }
    return
  }

  let pendingPrompt: ZenBeforeInstallPromptEvent | null = null
  let lastEvent: ZenBeforeInstallPromptEvent | null = null
  let fired = false
  /** The event whose `prompt()` is waiting for the sheet's outcome. */
  const awaitOutcome = (event: ZenBeforeInstallPromptEvent): void => {
    pendingPrompt = event
  }

  class ZenBeforeInstallPromptEvent extends Event {
    readonly platforms = ['web']
    private settled = false
    private prompted = false
    private resolveChoice!: (choice: InstallChoice) => void
    readonly userChoice: Promise<InstallChoice>

    constructor() {
      super('beforeinstallprompt', { cancelable: true })
      this.userChoice = new Promise<InstallChoice>((resolve) => {
        this.resolveChoice = resolve
      })
    }

    prompt(): Promise<InstallChoice> {
      if (this.prompted) {
        return Promise.reject(
          new DOMException('The prompt() method may only be called once.', 'InvalidStateError')
        )
      }
      const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation
      if (activation && !activation.isActive) {
        return Promise.reject(
          new DOMException('prompt() requires a user gesture.', 'NotAllowedError')
        )
      }
      this.prompted = true
      awaitOutcome(this)
      transport.send({ type: 'webapp', webapp: 'prompt' })
      return this.userChoice
    }

    settle(outcome: InstallOutcome): void {
      if (this.settled) return
      this.settled = true
      this.resolveChoice({ outcome, platform: 'web' })
    }
  }

  // `window.onbeforeinstallprompt = fn` works like the native handler attribute would.
  const defineHandlerAttribute = (type: string): void => {
    const name = `on${type}`
    if (name in window) return
    let handler: EventListener | null = null
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: () => handler,
        set: (value: unknown) => {
          if (handler) window.removeEventListener(type, handler)
          handler = typeof value === 'function' ? (value as EventListener) : null
          if (handler) window.addEventListener(type, handler)
        }
      })
    } catch {
      /* a frozen window keeps the standard listener path */
    }
  }
  defineHandlerAttribute('beforeinstallprompt')
  defineHandlerAttribute('appinstalled')

  const fire = (): void => {
    if (fired) return
    fired = true
    try {
      const event = new ZenBeforeInstallPromptEvent()
      lastEvent = event
      const proceed = window.dispatchEvent(event)
      if (!proceed) transport.send({ type: 'webapp', webapp: 'deferred' })
    } catch {
      /* a listener threw; the browser's own prompt still applies */
    }
  }

  transport.onWebApp?.((message) => {
    try {
      switch (message.action) {
        case 'installable':
          if (document.readyState === 'loading')
            document.addEventListener('DOMContentLoaded', fire, { once: true })
          else fire()
          return
        case 'result': {
          const outcome: InstallOutcome = message.outcome === 'accepted' ? 'accepted' : 'dismissed'
          const target = pendingPrompt ?? lastEvent
          pendingPrompt = null
          target?.settle(outcome)
          return
        }
        case 'installed':
          pendingPrompt?.settle('accepted')
          lastEvent?.settle('accepted')
          pendingPrompt = null
          window.dispatchEvent(new Event('appinstalled'))
          return
      }
    } catch {
      /* never let the polyfill throw into the page */
    }
  })
}

// ---------------------------------------------------------------------------
// OpenSearch: the page's own search engine
// ---------------------------------------------------------------------------

/** The longest link title carried across the bridge; the description's ShortName wins anyway. */
const MAX_OPENSEARCH_TITLE = 64

/**
 * Whether a `<link>` names an OpenSearch description: `rel` carries the `search` token (case-
 * insensitive, in a token list) and `type` is `application/opensearchdescription+xml` (any
 * parameters and case aside). A `rel="search"` without the type is a site's own search page.
 */
export function isOpenSearchLink(rel: string, type: string): boolean {
  const mime = type.split(';')[0].trim().toLowerCase()
  if (mime !== 'application/opensearchdescription+xml') return false
  return rel
    .toLowerCase()
    .split(/\s+/)
    .some((token) => token === 'search')
}

/**
 * The first OpenSearch link of the top frame of an http(s) document, posted once per document
 * (at DOMContentLoaded and once more at load for frameworks that inject the link late). The
 * description itself is fetched by the browser, off the page: what leaves the page is a URL and
 * the link's title. Best effort; never throws into the page.
 */
function installOpenSearch(transport: PageScriptTransport): void {
  try {
    if (window !== window.top) return
    if (location.protocol !== 'https:' && location.protocol !== 'http:') return
  } catch {
    return
  }
  let posted = false
  const probe = (): void => {
    if (posted) return
    let link: HTMLLinkElement | null = null
    try {
      for (const candidate of document.querySelectorAll('link[rel]')) {
        const l = candidate as HTMLLinkElement
        if (
          isOpenSearchLink(l.getAttribute('rel') ?? '', l.getAttribute('type') ?? '') &&
          /^https?:\/\//i.test(l.href)
        ) {
          link = l
          break
        }
      }
    } catch {
      return
    }
    if (!link) return
    posted = true
    transport.send({
      type: 'opensearch',
      url: link.href,
      title: (link.getAttribute('title') ?? '').trim().slice(0, MAX_OPENSEARCH_TITLE)
    })
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', probe, { once: true })
  else probe()
  window.addEventListener('load', probe, { once: true })
}
