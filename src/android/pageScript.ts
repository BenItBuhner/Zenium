import { installPageScript, type PageScriptFlags, type WebAppHostMessage } from '@shared/pageScript'
import type { PageHint } from '@shared/fullscreenHint'
import type { PageRules } from '@shared/types'
import { installFormsScript } from '@shared/formsScript'
import { installPasskeyObserver } from '@shared/passkeyObserver'
import type { FormsCommand } from '@shared/forms'
import type { MediaSessionHostMessage } from '@shared/mediaSession'
import type { NotificationHostMessage } from '@shared/notifications'
import type { ReadAloudHostMessage } from '@shared/readAloud'
import { installNotificationPolyfill } from '@shared/notificationScript'
import { installShareBridge, installShareShim, type ShareOutcome } from '@shared/share'
import { installTextFragmentScript, type TextFragmentHostMessage } from '@shared/textFragmentScript'
import { downloadNameOf, rememberDownloadName, type DownloadNames } from './downloadNames'
import { rememberClearedSelection } from './selectionMemory'
import { installViewportController, type PageRulesConfig } from './viewport'

/**
 * Injected by Kotlin into every page WebView (document-start). Transport is the
 * `WebViewCompat.addWebMessageListener` object `__zenPageBridge`: messages go up with
 * `postMessage`, flags and forms commands come back through its `onmessage`. Kotlin replaces
 * `__ZEN_TOKEN__` with a per-session secret so pages cannot forge browser messages.
 *
 * Kotlin prefixes the script with the page-controls rules (`window.__zenPageRules`) and the
 * view's width (`window.__zenDeviceWidth`), so zoom, the desktop layout and force-zoom are laid
 * out from the first viewport meta on; rule changes arrive live as `pageRules` messages.
 */
interface PageBridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
  addEventListener?(type: 'message', listener: (event: { data: string }) => void): void
}

const TOKEN = '__ZEN_TOKEN__'

/**
 * Keep the `download` attribute of clicked anchors where Kotlin can read it
 * (`window.__zeniumDownloadNames`, keyed as in `downloadNames.ts`): the WebView's download
 * callback never carries it, and it is the only name a `blob:` or `data:` download has. Real
 * clicks are seen in the capture phase; programmatic `a.click()` on a detached anchor (the
 * common save-a-blob pattern) is seen through the prototype.
 */
function installDownloadNames(w: Window & { __zeniumDownloadNames?: DownloadNames }): void {
  const names: DownloadNames = {}
  w.__zeniumDownloadNames = names
  const remember = (anchor: HTMLAnchorElement): void => {
    const hit = downloadNameOf(anchor)
    if (hit) rememberDownloadName(names, hit.href, hit.name)
  }
  w.addEventListener(
    'click',
    (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a[download]')
      if (anchor instanceof HTMLAnchorElement) remember(anchor)
    },
    true
  )
  const proto = HTMLAnchorElement.prototype as HTMLAnchorElement & { click(): void }
  const nativeClick = proto.click
  proto.click = function (this: HTMLAnchorElement): void {
    try {
      remember(this)
    } catch {
      /* a page's own subclass may throw on attribute access */
    }
    nativeClick.call(this)
  }
}

;(() => {
  const w = window as unknown as Window & {
    __zenPageBridge?: PageBridge
    __zenPageInstalled?: boolean
    __zeniumDownloadNames?: DownloadNames
    __zenPageRules?: PageRules
    __zenDeviceWidth?: number
  }
  if (w.__zenPageInstalled) return
  w.__zenPageInstalled = true
  try {
    installDownloadNames(w)
  } catch {
    /* pages that freeze the anchor prototype keep their downloads, just without the name */
  }

  // Only the top frame's viewport meta lays anything out, so only the top frame gets the
  // controller: an iframe (an ad, an embed) is spared an observer over its whole document.
  const topFrame = w === w.top
  let viewport =
    topFrame && w.__zenPageRules
      ? installViewportController({
          rules: w.__zenPageRules,
          deviceWidth: typeof w.__zenDeviceWidth === 'number' ? w.__zenDeviceWidth : 0
        })
      : null
  // The rules were only ever for this script; pages keep no trace of them.
  delete w.__zenPageRules
  delete w.__zenDeviceWidth

  const bridge = w.__zenPageBridge
  if (!bridge) return

  let onFlags: ((flags: PageScriptFlags) => void) | null = null
  let onZap: ((on: boolean) => void) | null = null
  let onForms: ((command: FormsCommand) => void) | null = null
  let onWebApp: ((message: WebAppHostMessage) => void) | null = null
  let onMediaSession: ((message: MediaSessionHostMessage) => void) | null = null
  let onNotification: ((message: NotificationHostMessage) => void) | null = null
  let onReadAloud: ((message: ReadAloudHostMessage) => void) | null = null
  let onHint: ((hint: PageHint | null) => void) | null = null
  let onShareResult: ((id: string, result: ShareOutcome) => void) | null = null
  let onTextFragment: ((message: TextFragmentHostMessage) => void) | null = null
  const selectionMemory = rememberClearedSelection(document)
  const onMessage = (event: { data: string }): void => {
    try {
      const data = JSON.parse(event.data) as {
        type?: string
        flags?: PageScriptFlags
        on?: boolean
        rules?: PageRules
        deviceWidth?: number
        command?: FormsCommand
        action?: string
        outcome?: WebAppHostMessage['outcome']
        seekTime?: number
        seekOffset?: number
        status?: NotificationHostMessage['status']
        id?: string
        hint?: PageHint | null
        result?: string
      }
      if (data.type === 'flags' && data.flags) onFlags?.(data.flags)
      else if (data.type === 'zap') onZap?.(Boolean(data.on))
      // The browser's fullscreen hint, drawn over the page in its top layer (null takes it down).
      else if (data.type === 'hint') onHint?.(data.hint ?? null)
      else if (data.type === 'forms' && data.command) onForms?.(data.command)
      else if (data.type === 'webapp' && data.action)
        onWebApp?.({
          type: 'webapp',
          action: data.action as WebAppHostMessage['action'],
          outcome: data.outcome
        })
      else if (data.type === 'mediaSession' && data.action) {
        const message: MediaSessionHostMessage = {
          type: 'mediaSession',
          action: data.action as MediaSessionHostMessage['action']
        }
        if (typeof data.seekTime === 'number') message.seekTime = data.seekTime
        if (typeof data.seekOffset === 'number') message.seekOffset = data.seekOffset
        if (typeof data.on === 'boolean') message.on = data.on
        onMediaSession?.(message)
      } else if (data.type === 'notification' && data.action) {
        const message: NotificationHostMessage = {
          type: 'notification',
          action: data.action as NotificationHostMessage['action']
        }
        if (data.status !== undefined) message.status = data.status
        if (typeof data.id === 'string') message.id = data.id
        onNotification?.(message)
      } else if (data.type === 'readAloud' && data.action) {
        // The core's extraction request or highlight (`readAloudScript.ts` checks the fields).
        const message = data as unknown as ReadAloudHostMessage
        // The selection toolbar's Read Aloud: the action mode's finish collapsed the selection
        // before this request arrived, so the one it cleared stands in (`selectionMemory.ts`).
        if (message.action === 'extract' && message.from === 'selection') {
          selectionMemory.withCleared(() => onReadAloud?.(message))
        } else {
          onReadAloud?.(message)
        }
      } else if (data.type === 'share' && typeof data.id === 'string') {
        // A `navigator.share` call's outcome from the system sheet (SH-14): the promise settles.
        onShareResult?.(data.id, data.result === 'shared' ? 'shared' : 'aborted')
      } else if (
        data.type === 'textFragment' &&
        data.action === 'generate' &&
        typeof data.id === 'string'
      ) {
        // The core wants a link to the highlight (SH-11): the toolbar's finish has collapsed the
        // selection by now, so the one it cleared stands in, as for Read Aloud above.
        const message: TextFragmentHostMessage = {
          type: 'textFragment',
          action: 'generate',
          id: data.id
        }
        onTextFragment?.(message)
      } else if (data.type === 'pageRules' && data.rules && topFrame) {
        const config: PageRulesConfig = {
          rules: data.rules,
          deviceWidth: typeof data.deviceWidth === 'number' ? data.deviceWidth : 0
        }
        if (viewport) viewport.update(config)
        else viewport = installViewportController(config)
      }
    } catch {
      /* ignore */
    }
  }
  if (bridge.addEventListener) bridge.addEventListener('message', onMessage)
  else bridge.onmessage = onMessage

  // The document's DOMContentLoaded, for the core's `dom-ready` (Kotlin raises the view event
  // once per document): from the top frame only – the legacy bridge cannot tell frames apart –
  // and at once from a script that runs after the fact (no document-start support, so it arrived
  // at page finished).
  if (w.self === w.top) {
    const domReady = (): void =>
      bridge.postMessage(JSON.stringify({ token: TOKEN, type: 'domReady' }))
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', domReady, { once: true })
    } else {
      domReady()
    }
  }

  // This script runs in the page's own world, so the WebAuthn observer installs directly.
  try {
    installPasskeyObserver(w)
  } catch {
    /* a page that seals navigator.credentials keeps its passkeys unlisted */
  }
  installFormsScript({
    send: (forms) => bridge.postMessage(JSON.stringify({ token: TOKEN, type: 'forms', forms })),
    onCommand: (listener) => {
      onForms = listener
    }
  })

  installPageScript({
    trackMedia: true,
    // The WebView blocks pop-ups itself; this script runs in the page's world and can see which.
    reportBlockedPopups: true,
    // A page's OpenSearch description makes it a "Recently visited" engine in Settings > Search.
    discoverSearchEngines: true,
    // A fullscreen video's size turns the screen (Host.kt, MED-01). This script runs in the top
    // document and in every frame, and each reports its own fullscreen: an embed's video goes
    // fullscreen from its frame's document, the one that knows the size, while the top document
    // sees only the <iframe>. The view lets a frame's fullscreen report through alone
    // (TabWebView.onPageMessage); the host weighs it against the top document's.
    reportFullscreen: true,
    // Rotate-to-fullscreen (MED-02): the turn of the screen takes a playing video with native
    // controls fullscreen and the turn away brings it back, inside the page's own `change` event
    // (shared/rotateToFullscreen.ts); the host holds and releases the screen (FullscreenRotation.kt).
    rotateToFullscreen: true,
    send: (message) => bridge.postMessage(JSON.stringify({ token: TOKEN, ...message })),
    // The fullscreen exit hint (GN-20): the chrome is under the fullscreen layer, so the hint
    // is drawn in the page's top layer, as the desktop's fullscreen hints are.
    onHint: (listener) => {
      onHint = listener
    },
    onFlags: (listener) => {
      onFlags = listener
      // Ask for the current flags; the reply arrives through the listener above.
      bridge.postMessage(JSON.stringify({ token: TOKEN, type: 'hello' }))
    },
    onZap: (listener) => {
      onZap = listener
    },
    onWebApp: (listener) => {
      onWebApp = listener
    },
    onMediaSession: (listener) => {
      onMediaSession = listener
    },
    // Read aloud (A11Y-06; services' model, #246): the core's `readAloud.extract` request is
    // answered with the document's blocks and its `readAloud.highlight` messages are painted
    // through the CSS Custom Highlight API. Kotlin posts to the main frame alone, so only the
    // top document ever hears these; the answer rides the `pageMessage` view event like the rest.
    onReadAloud: (listener) => {
      onReadAloud = listener
    }
  })

  // `Notification` for the pages: the WebView hides the API, the browser shows the shade's cards
  // under the site's channel. Top frame only: an embedded frame's notifications are its own
  // page's business in Chrome too (they come through the embedder's permission).
  if (topFrame) {
    try {
      installNotificationPolyfill({
        send: (message) => bridge.postMessage(JSON.stringify({ token: TOKEN, ...message })),
        onNotification: (listener) => {
          onNotification = listener
        }
      })
    } catch {
      /* a page that sealed `window` keeps going without notifications */
    }
    // `navigator.share` / `canShare` (SH-14): the WebView has neither. The shim and its bridge
    // share this one world (no isolated world here), so the shim installs directly; the call
    // goes up with its files as base64 (Kotlin writes them to its cache on the way, the core
    // hands the OS's sheet the addresses) and the sheet's outcome comes back through `onmessage`
    // above. The shim keeps Chrome's rules: a secure top-level document, a user gesture, one
    // share at a time, Chrome's file limits.
    try {
      installShareBridge({
        send: (call) =>
          bridge.postMessage(JSON.stringify({ token: TOKEN, type: 'share', share: call })),
        onResult: (listener) => {
          onShareResult = listener
        },
        installShim: (events) => installShareShim(events)
      })
    } catch {
      /* a page that sealed `navigator` keeps the engine's absence of the API */
    }
    // Links to a highlight (SH-11): the core's request for the selection's `text=` directive,
    // answered from the selection – or the one the action mode just cleared – and, on this
    // WebView, which leaves text fragments off, the URL's own directive scrolled to and painted.
    try {
      installTextFragmentScript({
        send: (message) => bridge.postMessage(JSON.stringify({ token: TOKEN, ...message })),
        onCommand: (listener) => {
          onTextFragment = listener
        },
        withSelection: (work) => selectionMemory.withCleared(work)
      })
    } catch {
      /* a page without a body yet, or one that sealed `document`: no link to its text */
    }
  }
})()
