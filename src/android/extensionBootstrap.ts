import type {
  BootConfig,
  BootErrorStat,
  BootGroup,
  BootStats,
  ContentBootConfig,
  ExtensionBoot,
  IsolationMode,
  UnitWorld
} from '@core/extensions/runtime/boot'
import { localizeCss } from '@core/extensions/api/i18n'
import type { FrameContext } from '@core/extensions/api/matchPattern'
import { decideFrameBoot } from '@core/extensions/runtime/frameBoot'
import {
  capturePrimordials,
  createEmulatedEngine,
  type EmulatedEngine,
  type EngineContextKind,
  type Primordials
} from '@core/extensions/api/engine'
import { EXTENSION_ORIGIN_SUFFIX, extensionOrigin } from '@core/extensions/runtime/plan'
import {
  scheduleRunAt,
  type LifecycleHooks,
  type ReadyState
} from '@core/extensions/runtime/scheduling'
import {
  collectBuiltins,
  collectOperations,
  createScopeProxy,
  installTrustedTypesShield,
  ownScriptMatcher,
  type Any,
  type ShieldResult
} from './extensionIsolation'
import { installModuleChrome } from './extensionModuleChrome'
import { createScriptRecovery, type ScriptRecovery } from './extensionScriptRecovery'
import {
  importScriptsFor,
  installServiceWorkerClient,
  installServiceWorkerGlobals,
  installWorkerScriptRescue,
  workerSelf,
  type ServiceWorkerEndpoint,
  type ServiceWorkerMessage
} from './extensionServiceWorker'
import type { ClaimedTransport, TransportJanitor } from './extensionTransport'
import { installCorsProxy } from './extensionCorsProxy'
import { createFetchRelay, type FetchRelay } from './extensionFetchRelay'
import { installExtensionUrlRewrite } from './extensionFrameUrls'
import { installPdfDocumentType } from './extensionPdfDocument'
import { installSpeechSynthesis } from './extensionSpeechSynthesis'
import { installUrlOrigin, scopedUrlClass } from './extensionUrlOrigin'

/**
 * The extension bootstrap Kotlin injects at document start into tab WebViews (content mode) and
 * into background pages, popups and options pages on the fake extension origin (page mode). It
 * runs on the shared engine (`api/engine.ts` + the shared shim): this file only decides where
 * the engine's `chrome` lives and when each content-script group runs. Kotlin assembles the
 * injected script as
 *
 *   (function () {
 *     var __zenExtBoot = { config: {...}, sources: { "<ext>/<group>": function (window, self,
 *       globalThis, chrome, browser) { <js files of the group> }, ... }, css: { "<ext>/<path>":
 *       "<css text>" } };
 *     <this file, bundled as an IIFE>
 *   })();
 *
 * so the extension sources are real function literals compiled with the injected script itself
 * (no eval: a page's Content-Security-Policy cannot block them) and every file of a declaration
 * shares one function scope, as the files of one isolated world share their global scope.
 *
 * One unit is one extension in one world: with real isolated worlds (Chromium 146+) each
 * extension's units run in its own world (`isolation: "world"`), whose global is the content
 * scripts' `window`; without worlds every unit runs in the page's main world behind the `with`
 * scope proxy (`isolation: "with"`). Units of one world share one transport: the first installs
 * it and exposes `__zenExtRuntime.attach`, which later units call with their boot (token-checked,
 * so the page cannot attach anything).
 *
 * Transport is the WebMessageListener object `__zenExtBridge` of the world: messages go up with
 * `postMessage`, replies come back through its `onmessage` (the frame's JavaScriptReplyProxy for
 * that world). The object is captured and deleted from the global before any page script can
 * see it; in the main world the transport janitor (`extensionTransport.ts`) has done that
 * already and hands it over through `__zenExtTransport.claim(token)`, and the runtime and exec
 * objects go into the slots it reserved. The janitor keeps one sink, so whichever copy claims
 * last is the one the host reaches: an extension page open as a tab installs a runtime of its
 * own for that reason (page mode below). A late boot (`config.late`) is this same script
 * evaluated by the host into a document that predates the extension's world (or on a WebView
 * without worlds): no groups run, but `scripting.executeScript` / `insertCSS` get a scope and a
 * bridge to work with.
 */
type GroupFunction = (
  this: unknown,
  window: unknown,
  self: unknown,
  globalThis: unknown,
  chrome: unknown,
  browser: unknown,
  /** The host's mirror line calls it per top-level declaration of the files, after they ran (`TopLevelDeclarations.kt`). */
  mirror: (name: string, value: unknown) => void
) => unknown

interface Boot {
  config: BootConfig
  sources: Record<string, GroupFunction>
  css: Record<string, string>
  /** Debug builds expose `__zenExtStats` so the probe can read timings. */
  debug?: boolean
}

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
  addEventListener?(type: 'message', listener: (event: { data: string }) => void): void
}

interface Runtime {
  attach(boot: Boot): void
}

declare const __zenExtBoot: Boot

;(() => {
  const t0 = performance.now()
  const boot = __zenExtBoot
  const g = globalThis as typeof globalThis & {
    __zenExtBridge?: Bridge
    __zenExtRuntime?: Runtime
    __zenExtTransport?: TransportJanitor
  }
  const installed = g.__zenExtRuntime
  if (installed) {
    installed.attach(boot)
    return
  }

  // --- transport ---------------------------------------------------------------------------------
  // The main world of a tab frame: the janitor took the bridge off the global before any page
  // script ran and lends it to the holder of the token, so nothing the page did can have replaced
  // it. Isolated worlds and extension pages meet the bridge directly: nothing runs there first.
  let janitor: TransportJanitor | undefined
  let transport: ClaimedTransport | undefined
  const rawBridge = g.__zenExtBridge
  if (rawBridge) {
    try {
      delete g.__zenExtBridge
    } catch {
      /* leave it; the object only carries JSON */
    }
    const rawPost = rawBridge.postMessage
    transport = {
      post: (message) => rawPost.call(rawBridge, message),
      listen: (sink) => {
        if (rawBridge.addEventListener) rawBridge.addEventListener('message', sink)
        else rawBridge.onmessage = sink
      },
      primordials: capturePrimordials()
    }
  } else {
    janitor = g.__zenExtTransport
    if (janitor && typeof janitor.claim === 'function') {
      try {
        transport = janitor.claim(boot.config.token)
      } catch {
        transport = undefined
      }
    }
  }
  if (!transport) return
  /** Both directions of this copy's bridge traffic, exposed on the debug stats (`BootStats.bridge`). */
  const bridgeTraffic = { hostBound: 0, pageBound: 0 }
  const rawPost = transport.post
  const post = (message: string): void => {
    bridgeTraffic.hostBound++
    rawPost(message)
  }
  const primordials: Primordials = transport.primordials
  const sources: Record<string, GroupFunction> = Object.assign(
    Object.create(null) as Record<string, GroupFunction>,
    boot.sources
  )
  const cssTexts: Record<string, string> = Object.assign(
    Object.create(null) as Record<string, string>,
    boot.css
  )
  const engines = new Map<string, EmulatedEngine>()
  /** Extension pages: the emulated service-worker platform's messages (`t: 'sw'`) per endpoint. */
  const serviceWorkerEndpoints = new Map<string, ServiceWorkerEndpoint>()
  /** Content mode: extension-origin `<script>` elements the page's CSP refused (see below). */
  let scriptRecovery: ScriptRecovery | null = null
  /** Content mode: extension-origin fetches the page's CSP refused, and the stylesheet recovery's reads (see below). */
  let fetchRelay: FetchRelay | null = null
  transport.listen((event) => {
    bridgeTraffic.pageBound++
    let message: Record<string, unknown>
    try {
      message = primordials.parse(event.data) as Record<string, unknown>
    } catch {
      return
    }
    const ep = String(message.ep)
    if (message.t === 'sw') {
      serviceWorkerEndpoints.get(ep)?.receive(message)
      return
    }
    if (message.t === 'mainScriptDone') {
      scriptRecovery?.done(
        String(message.id),
        message.ok === true ? null : String(message.error ?? 'the host refused')
      )
      return
    }
    if (message.t === 'extFetchDone') {
      fetchRelay?.done(String(message.id), message)
      return
    }
    const engine = engines.get(ep)
    if (engine) engine.receive(message)
  })

  /**
   * Expose a runtime object in the main world: through the janitor's reserved slots when it is
   * there (they are getters no page script can redefine), else as a frozen own property.
   */
  const expose = (name: '__zenExtRuntime' | '__zenExtExec', value: object): void => {
    try {
      Object.defineProperty(g, name, {
        value,
        writable: false,
        configurable: false,
        enumerable: false
      })
    } catch {
      /* the name exists already (a second bootstrap of the same world): keep the first */
    }
  }

  const nonce = Math.random().toString(36).slice(2, 10) + (Date.now() % 1e6).toString(36)
  /**
   * Kotlin drops a frame's endpoints when its main frame says hello for a different document.
   * One document runs several units, each with its own copy of this script (one per world, and
   * one per origin-rule set within a world), so the id has to come from the document:
   * `performance.timeOrigin` is the navigation start, identical in every world of the frame and
   * different for every navigation.
   */
  const docId =
    typeof performance === 'object' && performance && performance.timeOrigin > 0
      ? Math.round(performance.timeOrigin).toString(36)
      : nonce
  /**
   * One endpoint per extension per copy of this script; under the `with` fallback the copy also
   * holds an extension's user-script scope next to its content scope (two units of one main
   * world), and that engine's endpoint is told apart by its context.
   */
  const endpointIdFor = (extId: string, context: EngineContextKind = 'content'): string =>
    `${docId}.${nonce}${context === 'userScript' ? 'u' : ''}.${extId.slice(0, 8)}`
  const realWindow = window as unknown as Any
  const engineTransport = { post }

  // --- frame context ---------------------------------------------------------------------------

  function frameContext(): FrameContext {
    let isTopFrame = true
    try {
      isTopFrame = window.top === window
    } catch {
      isTopFrame = false
    }
    const url = location.href
    let precursorUrl: string | null = null
    if (
      !isTopFrame &&
      (url === 'about:blank' || url === 'about:srcdoc' || /^(data|blob):/.test(url))
    ) {
      try {
        precursorUrl = window.parent.location.href
      } catch {
        precursorUrl = document.referrer || null
      }
    }
    return { url, isTopFrame, precursorUrl }
  }

  /**
   * Debug: one uncaught error as the sweep reads it, with the stack and, for an inline script
   * (`document.currentScript` without `src`, still running while the event is dispatched), the
   * source around the throw; `frame` names a sub-frame's document, null for this one.
   */
  function bootErrorStat(event: Event, frame: string | null): BootErrorStat | null {
    if (!('message' in event) || typeof event.message !== 'string') return null
    const err = event as ErrorEvent
    const cause = err.error as { stack?: unknown } | null | undefined
    let inline: string | null = null
    const current = document.currentScript
    if (current && !(current as HTMLScriptElement).src) {
      const text = current.textContent ?? ''
      let at = 0
      for (let line = 1; line < err.lineno && at >= 0; line += 1) at = text.indexOf('\n', at) + 1
      at = Math.max(0, at + err.colno - 1)
      inline = text.slice(Math.max(0, at - 240), at) + ' >>> ' + text.slice(at, at + 160)
    }
    return {
      message: err.message,
      source: err.filename,
      line: err.lineno,
      column: err.colno,
      stack:
        cause && typeof cause === 'object' && typeof cause.stack === 'string'
          ? cause.stack.slice(0, 1200)
          : null,
      at: performance.now(),
      inline,
      frame
    }
  }

  /**
   * Debug: the uncaught errors of a sub-frame this copy leaves alone go onto the parent's stats
   * (`frameErrors`). Such an error never reaches the parent's `error` listeners, and its console
   * line does not name the frame; the frame's own window is where it can be caught, and a
   * listener there leaves the frame's globals and prototypes as they were.
   */
  function watchUntouchedFrame(frame: FrameContext): void {
    const parentStatsNow = (): BootStats | undefined => {
      try {
        return (window.parent as unknown as { __zenExtStats?: BootStats }).__zenExtStats
      } catch {
        return undefined
      }
    }
    const stats = parentStatsNow()
    if (stats) {
      const seen = (stats.untouchedFrames ??= [])
      if (seen.length < 24) seen.push(`${frame.url} < ${frame.precursorUrl ?? '-'}`)
    }
    window.addEventListener(
      'error',
      (event) => {
        const parentStats = parentStatsNow()
        if (!parentStats) return
        const list = (parentStats.frameErrors ??= [])
        const record = bootErrorStat(event, frame.url)
        if (record && list.length < 12) list.push(record)
      },
      true
    )
  }

  function makeEngine(
    ext: ExtensionBoot,
    context: EngineContextKind,
    frame: FrameContext,
    root: object,
    world: boolean
  ): EmulatedEngine {
    const endpointId = endpointIdFor(ext.id, context)
    const engine = createEmulatedEngine(
      {
        id: ext.id,
        origin: extensionOrigin(ext.id),
        manifest: ext.manifest,
        manifestVersion: ext.manifestVersion,
        permissions: ext.permissions,
        ...(Array.isArray(ext.optionalPermissions) && ext.optionalPermissions.length > 0
          ? { optionalPermissions: ext.optionalPermissions }
          : {}),
        messages: ext.messages,
        uiLanguage: boot.config.uiLanguage,
        context,
        token: boot.config.token,
        endpointId,
        url: frame.url,
        isTopFrame: frame.isTopFrame,
        world,
        ...(typeof boot.config.messageLimit === 'number' && boot.config.messageLimit > 0
          ? { maxMessageLength: boot.config.messageLimit }
          : {})
      },
      engineTransport,
      primordials,
      { root }
    )
    engines.set(endpointId, engine)
    return engine
  }

  // --- CSS ---------------------------------------------------------------------------------------

  const adopted = new Map<string, CSSStyleSheet | HTMLStyleElement>()

  /** Constructed stylesheets are CSSOM, not markup: a page's style-src CSP does not apply. */
  function injectCss(key: string, text: string): void {
    if (adopted.has(key)) return
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(text)
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
      adopted.set(key, sheet)
      return
    } catch {
      /* fall through to a <style> element */
    }
    const style = document.createElement('style')
    style.textContent = text
    ;(document.head ?? document.documentElement).appendChild(style)
    adopted.set(key, style)
  }

  function removeCss(key: string): void {
    const entry = adopted.get(key)
    if (!entry) return
    adopted.delete(key)
    if (entry instanceof CSSStyleSheet)
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== entry)
    else entry.remove()
  }

  /**
   * A CSS file of the extension's, as Chrome injects it: its `__MSG_name__` placeholders
   * substituted, `__MSG_@@extension_id__` first (`i18n.ts`). Steam Inventory Helper's sheet
   * names its images `url(chrome-extension://__MSG_@@extension_id__/...)`; unsubstituted, none
   * loaded. Substituted once per key: `injectCss` keeps the sheet by it.
   */
  function injectCssFile(ext: ExtensionBoot, key: string, text: string): void {
    if (adopted.has(key)) return
    injectCss(key, localizeCss(text, ext.id, boot.config.uiLanguage, ext.messages))
  }

  // --- page mode (background page, popup, options, offscreen, extension tab) -------------------

  if (boot.config.kind === 'page') {
    const ext = boot.config.extension
    const context = boot.config.context
    const frame = frameContext()
    const engine = makeEngine(ext, context, frame, realWindow, false)
    // An extension page open as a tab shares its main world with every other document-start
    // copy of this script whose origin rule covers it – the units over `*` of this extension
    // (a `world: "MAIN"` group on a WebView with isolated worlds, every group without them) and
    // of every other, and a late boot for an injection aimed at the tab. Chrome injects no
    // content scripts into extension pages and neither do those copies (they return in content
    // mode below), but a copy that finds no runtime installed claims the janitor's transport for
    // itself first, and the janitor's one sink moves to a copy that is about to return: from
    // then on nothing the host sends this page reaches its engine, without an error to show for
    // it (Adblock Plus's options page waited for good on the `app.get` it asks before it shows its
    // body, Ghostery's settings page on three `storage.get`, all four answered by the host). So
    // the page's copy installs the runtime the later copies attach to, with nothing of their
    // boots to run here, and an injection into the page is refused as Chrome refuses it. Only
    // the janitor's world hosts other copies: an ExtensionWebView runs the page script alone.
    if (janitor) {
      const pageRuntime: Runtime = { attach: () => undefined }
      Object.freeze(pageRuntime)
      janitor.install(boot.config.token, pageRuntime, (token: unknown) => {
        if (token !== boot.config.token) throw new Error('bad token')
        throw new Error(
          'Cannot access contents of the page. Extension manifest must request permission to access the respective host.'
        )
      })
    }
    const pageWindow = realWindow
    const origin = extensionOrigin(ext.id)
    const endpointId = endpointIdFor(ext.id)
    // The service-worker platform between an MV3 worker (a hidden page here) and its pages;
    // MV2 backgrounds are pages in Chrome too and get none of it.
    const background = ext.manifest.background as Record<string, unknown> | undefined
    const workerScript =
      background && typeof background.service_worker === 'string'
        ? new URL('/' + background.service_worker.replace(/^\/+/, ''), origin + '/').href
        : null
    const swSend = (message: ServiceWorkerMessage): void => engine.post({ t: 'sw', ...message })
    let lifecycle: (() => Promise<void>) | null = null

    // Cross-origin fetch / XHR to the hosts the extension's permissions cover go through
    // Kotlin's CORS proxy; bodied ones hand their body over first (extensionCorsProxy.ts).
    let ticketSeq = 0
    installCorsProxy(window, {
      origin,
      hostPermissions: ext.hostPermissions,
      postBody: (ticket, body) => engine.post({ t: 'proxyBody', ticket, body }),
      nextTicket: () => `${endpointId}:${++ticketSeq}`
    })
    // What the page spells `chrome-extension://<id>/...` by hand (a frame's src, an image's, a
    // script's) loads from the served origin: the WebView has no such scheme (extensionFrameUrls.ts).
    installExtensionUrlRewrite(window)
    // `new URL('chrome-extension://<id>/...').origin` is the extension's origin as this page
    // knows it, the served one, not the WebView's opaque "null" (extensionUrlOrigin.ts).
    installUrlOrigin(window)
    // The Web Speech API's synthesis, which Chrome's documents have and the WebView's do not,
    // over the host's speech engine (extensionSpeechSynthesis.ts; Read&Write's speech frame).
    // Not on the MV3 worker page: a service worker's global has none in Chrome.
    if (!(context === 'background' && workerScript))
      installSpeechSynthesis(pageWindow as unknown as Record<string, unknown>, {
        call: (method, args) => engine.call('speechSynthesis', method, args),
        onEvent: (listener) =>
          engine.onHostEvent((ns, name, args) => {
            if (ns === 'speechSynthesis') listener(name, args)
          }),
        listen: (event) => engine.post({ t: 'listen', event: `speechSynthesis.${event}`, on: true })
      })

    if (context === 'background' && workerScript) {
      // `self` and `globalThis` answer as a worker's global does (`workerSelf`: no `window`
      // or `document` until the script polyfills them, and its polyfills take); the page's own
      // `self` is [Replaceable] and `globalThis` writable, so both can be redefined.
      const workerGlobal = workerSelf(pageWindow)
      for (const name of ['self', 'globalThis']) {
        Object.defineProperty(pageWindow, name, {
          value: workerGlobal,
          configurable: true,
          writable: true
        })
      }
      // Service-worker globals the MV3 script expects; `importScripts` is synchronous by
      // contract, so it is a synchronous XHR to the extension origin and a classic script
      // element of this page (the generated background page carries no CSP that would refuse it);
      // what the element throws, the page reports to `window` and the call throws to its caller.
      const fetchText = (url: string): { status: number; text: string } => {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', url, false)
        xhr.send()
        return { status: xhr.status, text: xhr.responseText }
      }
      pageWindow.importScripts = importScriptsFor({
        origin,
        base: location.href,
        fetchText,
        document,
        errors: window
      })
      // A worker script that opens `let window = self` is this page's early SyntaxError (`window`
      // is the global's unforgeable property) and ran not at all; it runs again as a block of the
      // page, where a worker's declaration is legal (installWorkerScriptRescue).
      installWorkerScriptRescue({
        scriptUrl: workerScript,
        fetchText,
        document,
        errors: window,
        warn: (message) => console.warn(message)
      })
      const worker = installServiceWorkerGlobals(pageWindow, {
        origin,
        scriptUrl: location.href,
        version: ext.version,
        send: swSend,
        openTab: (url) => {
          const tabs = (engine.chrome as { tabs?: { create?: (p: { url: string }) => void } }).tabs
          tabs?.create?.({ url })
        },
        prefix: `${endpointId}:`
      })
      serviceWorkerEndpoints.set(endpointId, worker)
      lifecycle = worker.lifecycle
    } else if (workerScript) {
      serviceWorkerEndpoints.set(
        endpointId,
        installServiceWorkerClient(pageWindow, {
          origin,
          scriptUrl: workerScript,
          send: swSend,
          prefix: `${endpointId}:`
        })
      )
    }

    if (context === 'popup') {
      // Chrome closes the popup on window.close(); the host owns the sheet.
      pageWindow.close = (): void => engine.post({ t: 'closePopup' })
      // Chrome sizes a popup to its document's preferred size, not to the viewport it happens to
      // have: content that overflows wants that much room; otherwise the body's own box (a
      // `width: 300px` body is a 300 px popup, a short document a short popup). The viewport's
      // own extent is the answer only when the body fills it (`height: 100%`).
      const outer = (el: HTMLElement, axis: 'width' | 'height'): number => {
        const style = getComputedStyle(el)
        const margins =
          axis === 'width'
            ? (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0)
            : (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0)
        return el.getBoundingClientRect()[axis] + margins
      }
      const report = (): void => {
        const root = document.documentElement
        const body = document.body
        const overflowWidth = Math.max(root.scrollWidth, body ? body.scrollWidth : 0)
        const overflowHeight = Math.max(root.scrollHeight, body ? body.scrollHeight : 0)
        const width =
          overflowWidth > root.clientWidth || !body
            ? overflowWidth
            : Math.min(outer(body, 'width'), root.clientWidth)
        const height =
          overflowHeight > root.clientHeight || !body
            ? overflowHeight
            : Math.min(outer(body, 'height'), root.clientHeight)
        engine.post({ t: 'popupSize', width: Math.ceil(width), height: Math.ceil(height) })
      }
      window.addEventListener('load', () => {
        report()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(report)
          observer.observe(document.documentElement)
          if (document.body) observer.observe(document.body)
        }
      })
    }

    // The worker's `install` and `activate` (first run of a version) come before `ready`, which
    // is what releases `runtime.onInstalled` and the events held for the start.
    window.addEventListener(
      'load',
      () => {
        const ready = (): void => engine.ready()
        if (lifecycle) lifecycle().then(ready, ready)
        else ready()
      },
      { once: true }
    )
    return
  }

  // --- content mode ------------------------------------------------------------------------------

  // Extension pages open as tabs too (options pages, a changelog opened with `tabs.create`);
  // Chrome injects no content scripts into chrome-extension:// documents and neither do we.
  if (location.hostname.endsWith(EXTENSION_ORIGIN_SUFFIX)) return

  const content: ContentBootConfig = boot.config
  const unitWorld = content.world
  const frame = frameContext()
  // Chrome's rules for this frame (frameBoot.ts). In the main world of a frame Chrome would not
  // inject into (an about:blank / javascript: / srcdoc / data: sub-frame under the `with`
  // fallback with no declaration opting in) this copy leaves nothing behind: no transport, no
  // slots, no listeners. A later unit that does inject there installs the runtime itself.
  const first = decideFrameBoot(content.extension, frame, content.late === true)
  if (!first.touch) {
    if (boot.debug && !frame.isTopFrame) watchUntouchedFrame(frame)
    return
  }
  /** The frame's prototypes stay the page's: no Trusted Types shield here (frameBoot.ts). */
  const pristine = first.pristine
  const attached: ExtensionBoot[] = []

  /**
   * The world a unit's scripts see. A `user` unit's scripts get the user-script world's engine
   * (messaging only, and only when the extension configured it); every other unit's get the
   * content script's. Each unit that attaches to this copy of the script brings its own: under
   * the `with` fallback every unit of every extension lands in the one main world, and the first
   * copy to boot must not lend its world to the rest (a user-script unit booting first gave
   * Video Speed Controller's bridge a `chrome` without `storage` and Google Translate's script
   * one without `i18n`).
   */
  interface UnitContext {
    world: UnitWorld
    messaging: boolean
  }
  const unitContextOf = (config: ContentBootConfig): UnitContext => ({
    world: config.world,
    messaging: config.world !== 'user' || config.userScriptMessaging === true
  })
  /** What the host's `exec` and a late boot run as: the extension's content scope. */
  const contentUnit: UnitContext = { world: 'isolated', messaging: true }

  // A content script's `fetch` of its extension's file under the page's `connect-src`: the
  // page's fetch first, the host's answer over the bridge for an extension-origin file the
  // policy refused (`extensionFetchRelay.ts`). It is the content scripts' `fetch` in both
  // isolations: the `with` scope's, and the isolated world's own, which a WebView's world runs
  // under the document's policy too (Chrome's isolated world carries the extension's).
  fetchRelay = createFetchRelay(window, {
    attachedIds: () => attached.map((e) => e.id),
    request: (id, extId, url) =>
      post(
        primordials.stringify({
          t: 'extFetch',
          token: content.token,
          ep: endpointIdFor(extId),
          ext: extId,
          id,
          url
        })
      ),
    error: primordials.error
  })
  const relay = fetchRelay
  // A page's CSP has no say over an extension's resources in Chrome; over the emulated origin it
  // has. A `<script src=<extension origin>/…>` the page's `script-src` refused runs in the main
  // world through the host instead; a `<link rel=stylesheet>` its `style-src` refused is read
  // through the relay and adopted as a constructed sheet (`extensionScriptRecovery.ts`).
  scriptRecovery = createScriptRecovery({
    attachedIds: () => attached.map((e) => e.id),
    request: (id, extId, url) =>
      post(
        primordials.stringify({
          t: 'mainScript',
          token: content.token,
          ep: endpointIdFor(extId),
          ext: extId,
          id,
          url
        })
      ),
    readText: (_extId, url) => relay.fetch(url).then((response) => response.text()),
    error: primordials.error
  })
  const recovery = scriptRecovery
  window.addEventListener('error', (event) => recovery.onError(event), true)
  const builtins = collectBuiltins(realWindow)
  // The window's operations at document start, for the `with` fallback's scope proxies; read
  // once per frame, on the first proxy (a frame with worlds never needs it).
  let operations: ReadonlySet<PropertyKey> | null = null
  const stats: BootStats | null = boot.debug
    ? {
        frame: frame.url,
        world: unitWorld,
        isolation: content.extension.isolation,
        startedAt: t0,
        matchMs: 0,
        bootMs: 0,
        applied: 0,
        groups: [],
        trustedTypes: null,
        bridge: bridgeTraffic
      }
    : null
  if (stats) {
    Object.defineProperty(g, '__zenExtStats', {
      value: stats,
      enumerable: false,
      configurable: true
    })
    // The document's first uncaught errors, for the compat sweep: a console line gives an inline
    // script's error as `<document URL>:1`, which tells neither the code nor the caller; the
    // event still carries the stack, and the script element still runs while it is dispatched.
    const errors: BootErrorStat[] = (stats.errors = [])
    window.addEventListener(
      'error',
      (event) => {
        const record = bootErrorStat(event, null)
        if (record && errors.length < 12) errors.push(record)
      },
      true
    )
  }

  /**
   * A real isolated world enforces the page's Trusted Types CSP on the world's own DOM sinks
   * (m.youtube.com's `require-trusted-types-for 'script'` would refuse a content script's
   * `innerHTML = …`); in Chrome the extension's CSP applies there instead. A pass-through policy
   * over the world's sinks gives the scripts the same freedom, and the page's prototypes stay as
   * they were. In the `with` fallback the sinks are the page's own: there the shield only
   * retries a refused string the extension's own frame wrote (`ownScriptMatcher`: the host names
   * the document-start script with a `//# sourceURL`; without one the writers cannot be told
   * apart and the page's policy stands for everyone). Once per document.
   */
  let shielded = false
  function shieldWorld(ext: ExtensionBoot, isolation: 'world' | 'with'): void {
    if (shielded) return
    shielded = true
    // The phone's PDF viewer document reads as Chrome's to the extension: `application/pdf`
    // (extensionPdfDocument.ts); any other document is left as it is.
    installPdfDocumentType(window)
    let result: ShieldResult = { policy: false, patched: 0 }
    if (isolation === 'world')
      result = installTrustedTypesShield(realWindow, `zenium-ext-${ext.id.slice(0, 8)}`)
    else if (pristine) {
      /* a frame on an inherited origin keeps the page's sinks; its content scripts write under the page's policy */
    } else {
      const ownCaller = ownScriptMatcher(Error)
      if (ownCaller)
        result = installTrustedTypesShield(realWindow, `zenium-ext-${ext.id.slice(0, 8)}`, {
          ownCaller,
          Error
        })
    }
    if (stats) stats.trustedTypes = result
  }

  // --- per-extension scopes --------------------------------------------------------------------

  interface Scope {
    ext: ExtensionBoot
    engine: EmulatedEngine | null
    /** The content scripts' `window` (the world's global, the scope proxy or the real window). */
    window: Any
    chrome: unknown
    browser: unknown
    isolation: IsolationMode
    /**
     * What a script's top-level declaration becomes once the script ran: a property of the
     * scope's `window`, as Chrome's world has `var`, `function`, `let`, `const` and `class` at
     * a content script's top level as globals of the world, so the next injection of the same
     * extension (Read Aloud's `content.js`, then `js/content/html-doc.js` declaring
     * `readAloudDoc`; a `func` probe of `typeof brapi`) finds them by their bare names. The host
     * scans each file as it assembles the script and ends the function literal with one guarded
     * call per name (`TopLevelDeclarations.kt`); the function literal itself keeps a file's
     * declarations as its locals, which the bootstrap cannot see. A browser global's name is
     * left alone: the body already wrote through the proxy's setter (`with`) or shadowed it
     * (world), and `window.location = location` again would navigate.
     */
    mirror: (name: string, value: unknown) => void
  }
  const scopes = new Map<string, Scope>()

  const mirrorOnto = (target: Any): ((name: string, value: unknown) => void) => {
    return (name, value) => {
      if (typeof name !== 'string' || builtins.has(name)) return
      try {
        target[name] = value
      } catch {
        /* a non-writable global of the page's: Chrome's world would have shadowed it; the body did */
      }
    }
  }

  /**
   * How a content script sees the world: `world` – this very global, `chrome` lives on it;
   * `with` – the scope proxy, `chrome` lives in its store; `none` – the real window and the
   * page's own `chrome`, as `world: "MAIN"` scripts get in Chrome (no extension APIs, no
   * endpoint: the injection's result travels back through the host's own evaluation).
   * A content scope and a user-script scope of one extension are two scopes with two engines
   * (and two endpoints) even when both share this copy of the script.
   */
  function scopeFor(ext: ExtensionBoot, isolation: IsolationMode, unit: UnitContext): Scope {
    const context: EngineContextKind = unit.world === 'user' ? 'userScript' : 'content'
    const key = `${ext.id}/${isolation}/${context}`
    let scope = scopes.get(key)
    if (scope) return scope
    if (isolation === 'none') {
      scope = {
        ext,
        engine: null,
        window: realWindow,
        chrome: realWindow.chrome,
        browser: realWindow.browser,
        isolation,
        mirror: mirrorOnto(realWindow)
      }
      scopes.set(key, scope)
      return scope
    }
    const messaging = unit.messaging
    let root: Any
    if (isolation === 'world') {
      shieldWorld(ext, 'world')
      root = realWindow
      // The world's `fetch` is the relay's: the world's global is the content scripts' alone, so
      // the page's window never sees it, and the world's own fetch runs under the document's
      // `connect-src` on a WebView (RoPro's locale file refused on roblox.com with worlds too).
      if (fetchRelay) root.fetch = fetchRelay.fetch
      // The world's `URL` answers an extension URL's origin as the extension's pages know it
      // (extensionUrlOrigin.ts); the world's interface object is the content scripts' alone.
      installUrlOrigin(root)
    } else {
      shieldWorld(ext, 'with')
      operations ??= collectOperations(realWindow)
      root = createScopeProxy(realWindow, builtins, operations)
      // The scope's `fetch` (a bare `fetch(...)`, `window.fetch`, `self.fetch`) is the relay's:
      // the page's fetch first, the host's answer for an extension-origin file the page's policy
      // refused. It lands in the scope's own store, never on the page's window.
      if (fetchRelay) root.fetch = fetchRelay.fetch
      // The scope's `URL` is the page's subclassed, an extension URL's origin patched
      // (extensionUrlOrigin.ts); in the store too, the page's own `URL` untouched.
      if (typeof realWindow.URL === 'function')
        root.URL = scopedUrlClass(realWindow.URL as typeof URL)
      // A module the content script imports evaluates on the real global, not in the proxy's
      // scope: the host brackets the served module text, and this accessor answers the
      // extension's `chrome` there while the module's body runs (extensionModuleChrome.ts).
      installModuleChrome(realWindow, (id) => scopes.get(`${id}/with/content`)?.chrome)
    }
    // A user-script world without `configureWorld({ messaging: true })` has no `chrome` at all.
    const engine = messaging ? makeEngine(ext, context, frame, root, isolation === 'world') : null
    // The Web Speech API's synthesis in the content scripts' scope: Chrome's content script
    // reads the document's `speechSynthesis`, and a WebView's document has none (Speechify's
    // content bundle dies at `speechSynthesis.getVoices()`), so the host's engine answers it
    // here as it does an extension page's; in the world's global or the `with` scope's store,
    // never on the page's window.
    if (engine && context === 'content')
      installSpeechSynthesis(root, {
        call: (method, args) => engine.call('speechSynthesis', method, args),
        onEvent: (listener) =>
          engine.onHostEvent((ns, name, args) => {
            if (ns === 'speechSynthesis') listener(name, args)
          }),
        listen: (event) => engine.post({ t: 'listen', event: `speechSynthesis.${event}`, on: true })
      })
    scope = {
      ext,
      engine,
      window: root,
      chrome: engine ? engine.chrome : undefined,
      browser: engine ? (root.browser ?? engine.chrome) : undefined,
      isolation,
      mirror: mirrorOnto(root)
    }
    scopes.set(key, scope)
    return scope
  }

  const isolationOf = (ext: ExtensionBoot, group: BootGroup | null): IsolationMode =>
    group && group.world === 'MAIN' ? 'none' : ext.isolation

  function runGroup(scope: Scope, group: BootGroup): void {
    const started = performance.now()
    const readyState = document.readyState
    const nodes = document.documentElement
      ? document.documentElement.getElementsByTagName('*').length
      : 0
    let error: string | null = null
    for (const path of group.css) {
      const key = `${scope.ext.id}/${path}`
      const text = cssTexts[key]
      if (text !== undefined) injectCssFile(scope.ext, key, text)
    }
    const fn = sources[`${scope.ext.id}/${group.index}`]
    if (fn) {
      const w = scope.window
      try {
        fn.call(w, w, w, w, scope.chrome, scope.browser, scope.mirror)
      } catch (e) {
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        primordials.error(
          `[Zenium] content script of ${scope.ext.name} (group ${group.index}) threw`,
          e
        )
      }
    }
    if (stats)
      stats.groups.push({
        ext: scope.ext.id,
        group: group.index,
        runAt: group.runAt,
        at: started - t0,
        ms: performance.now() - started,
        readyState,
        nodes,
        error
      })
  }

  // --- executeScript / insertCSS from the host ------------------------------------------------

  /**
   * `__zenExtExec(token, extId, kind, payload, fn)`: Kotlin evaluates this from
   * `scripting.executeScript` / `insertCSS` – through the world endpoint's reply proxy into the
   * extension's world, or with `evaluateJavascript` into the main world (a `world: "MAIN"`
   * injection, or a document that predates the world after a late boot). The JS arrives as a
   * function literal compiled by the WebView's own script execution, so it is never eval'd
   * against the page's CSP; it runs in the extension's scope with its `chrome`. The token is
   * compared, not embedded, so `toString()` reveals nothing.
   */
  function exec(
    token: unknown,
    extId: unknown,
    kind: unknown,
    payload: unknown,
    fn: unknown
  ): unknown {
    if (token !== boot.config.token) throw new Error('bad token')
    const ext = attached.find((e) => e.id === extId)
    if (!ext) throw new Error('unknown extension')
    const options = (payload ?? {}) as {
      id?: unknown
      code?: unknown
      remove?: unknown
      file?: unknown
      world?: unknown
      messaging?: unknown
    }
    // `userScripts.execute` runs in the user-script world: the scope its registered scripts
    // share, with the `chrome` that world was configured (`messaging`), not the content script's.
    const unit: UnitContext =
      options.world === 'USER_SCRIPT'
        ? { world: 'user', messaging: options.messaging === true }
        : contentUnit
    // This copy may be the extension's `world: "MAIN"` unit, the only one the host finds in a
    // main frame when the extension declares no isolated-world script (Mobile simulator's
    // `frame-element-spoofer.js` alone): an injection into the default world still runs in the
    // extension's own scope with its `chrome`, under the `with` fallback here, as a late boot's
    // would; only a `world: "MAIN"` injection runs on the page's window.
    const isolation: IsolationMode =
      options.world === 'MAIN' ? 'none' : ext.isolation === 'none' ? 'with' : ext.isolation
    const scope = scopeFor(ext, isolation, unit)
    if (kind === 'css') {
      const key = `${ext.id}/#${String(options.id ?? options.code ?? '')}`
      if (options.remove) removeCss(key)
      // A file's text is localized as a manifest sheet is; an inline `css` string is not (Chrome).
      else if (options.file === true) injectCssFile(ext, key, String(options.code ?? ''))
      else injectCss(key, String(options.code ?? ''))
      return null
    }
    if (typeof fn !== 'function') throw new Error('no script')
    const w = scope.window
    return settleLater(
      scope,
      (fn as GroupFunction).call(w, w, w, w, scope.chrome, scope.browser, scope.mirror)
    )
  }

  let execTickets = 0

  /**
   * Chrome awaits an injection whose value is a promise – an `async` func (Image Downloader's
   * `findImages`), a script whose last statement is one – and answers the settled value. The
   * host's evaluation returns synchronously and would serialize the promise as `{}`, so a
   * thenable comes back as a ticket the runtime holds (`exec` in `extensionRuntime.ts`) and the
   * frame settles it over the extension's endpoint (`execSettled`, a bridge message like
   * `mainScript`) when the promise does; a value the bridge cannot carry (a DOM node, a cycle)
   * settles as null, a rejection with its message. A scope without an engine of the extension's
   * in this copy (a `world: "MAIN"` injection on a WebView with worlds) has no bridge to settle
   * over and answers the value as it is.
   */
  function settleLater(scope: Scope, value: unknown): unknown {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value
    let then: unknown
    try {
      then = (value as { then?: unknown }).then
    } catch {
      return value
    }
    if (typeof then !== 'function') return value
    const engine =
      scope.engine ??
      scopes.get(`${scope.ext.id}/with/content`)?.engine ??
      scopes.get(`${scope.ext.id}/world/content`)?.engine ??
      null
    if (!engine) return value
    let ep: string | null = null
    for (const [id, candidate] of engines) if (candidate === engine) ep = id
    if (ep === null) return value
    const ticket = `${nonce}.${++execTickets}`
    let settled = false
    const settle = (ok: boolean, result: unknown, error: string): void => {
      if (settled) return
      settled = true
      let carried: unknown = result
      if (ok && result !== undefined) {
        try {
          primordials.stringify(result)
        } catch {
          carried = null
        }
      }
      engine.post({ t: 'execSettled', ticket, ok, result: carried ?? null, error })
    }
    try {
      ;(then as (a: (v: unknown) => void, b: (e: unknown) => void) => unknown).call(
        value,
        (v) => settle(true, v, ''),
        (e) => settle(false, null, e instanceof Error ? e.message : String(e))
      )
    } catch (e) {
      settle(false, null, e instanceof Error ? e.message : String(e))
    }
    return { __zenExtPending: ticket, ep }
  }

  // --- matching and scheduling -----------------------------------------------------------------

  const hooks: LifecycleHooks = {
    readyState: () => document.readyState as ReadyState,
    onDomContentLoaded: (cb) => document.addEventListener('DOMContentLoaded', cb, { once: true }),
    onLoad: (cb) => window.addEventListener('load', cb, { once: true }),
    setTimeout: (cb, ms) => void primordials.setTimeout(cb, ms)
  }

  /**
   * Match one unit's extension against this frame and schedule what applies. A late boot (the
   * host evaluated the bootstrap in a document that predates the extension's world) carries no
   * groups: it only gives `exec` a scope and a bridge, and says hello like any other endpoint.
   */
  const apply = (ext: ExtensionBoot, late: boolean, unit: UnitContext, started: number): void => {
    if (!attached.some((e) => e.id === ext.id)) attached.push(ext)
    const due = decideFrameBoot(ext, frame, late).groups
    if (stats) stats.matchMs += performance.now() - started
    if (late) scopeFor(ext, ext.isolation === 'none' ? 'with' : ext.isolation, contentUnit)
    for (const group of due) {
      const scope = scopeFor(ext, isolationOf(ext, group), unit)
      scheduleRunAt(group.runAt, hooks, () => runGroup(scope, group))
    }
    if (stats) {
      stats.applied += due.length
      stats.bootMs += performance.now() - started
    }
  }
  apply(content.extension, content.late === true, unitContextOf(content), t0)

  const runtime: Runtime = {
    attach(other) {
      const t = performance.now()
      if (other.config.token !== content.token || other.config.kind !== 'content') return
      Object.assign(sources, other.sources)
      Object.assign(cssTexts, other.css)
      apply(other.config.extension, other.config.late === true, unitContextOf(other.config), t)
    }
  }
  Object.freeze(runtime)
  if (janitor) janitor.install(content.token, runtime, exec as (...args: unknown[]) => unknown)
  else {
    expose('__zenExtRuntime', runtime)
    expose('__zenExtExec', exec)
  }
})()
