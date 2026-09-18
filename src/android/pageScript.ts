import { installPageScript, type PageScriptFlags } from '@shared/pageScript'
import type { PageRules } from '@shared/types'
import { downloadNameOf, rememberDownloadName, type DownloadNames } from './downloadNames'
import { installViewportController, type PageRulesConfig } from './viewport'

/**
 * Injected by Kotlin into every page WebView (document-start). Transport is the
 * `WebViewCompat.addWebMessageListener` object `__zenPageBridge`: messages go up with
 * `postMessage`, flags come back through its `onmessage`. Kotlin replaces `__ZEN_TOKEN__` with a
 * per-session secret so pages cannot forge browser messages.
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
  const onMessage = (event: { data: string }): void => {
    try {
      const data = JSON.parse(event.data) as {
        type?: string
        flags?: PageScriptFlags
        on?: boolean
        rules?: PageRules
        deviceWidth?: number
      }
      if (data.type === 'flags' && data.flags) onFlags?.(data.flags)
      else if (data.type === 'zap') onZap?.(Boolean(data.on))
      else if (data.type === 'pageRules' && data.rules && topFrame) {
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

  installPageScript({
    trackMedia: true,
    // The WebView blocks pop-ups itself; this script runs in the page's world and can see which.
    reportBlockedPopups: true,
    send: (message) => bridge.postMessage(JSON.stringify({ token: TOKEN, ...message })),
    onFlags: (listener) => {
      onFlags = listener
      // Ask for the current flags; the reply arrives through the listener above.
      bridge.postMessage(JSON.stringify({ token: TOKEN, type: 'hello' }))
    },
    onZap: (listener) => {
      onZap = listener
    }
  })
})()
