import type {
  BootConfig,
  BootGroup,
  BootStats,
  ContentBootConfig,
  ExtensionBoot,
  IsolationMode,
  UnitWorld
} from '@core/extensions/runtime/boot'
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
  type ServiceWorkerEndpoint,
  type ServiceWorkerMessage
} from './extensionServiceWorker'
import type { ClaimedTransport, TransportJanitor } from './extensionTransport'
import { installCorsProxy } from './extensionCorsProxy'

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
  browser: unknown
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
  const post = transport.post
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
  transport.listen((event) => {
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
        messages: ext.messages,
        uiLanguage: boot.config.uiLanguage,
        context,
        token: boot.config.token,
        endpointId,
        url: frame.url,
        isTopFrame: frame.isTopFrame,
        world
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

    if (context === 'background' && workerScript) {
      // Service-worker globals the MV3 script expects; `importScripts` is synchronous by
      // contract, so it is a synchronous XHR to the extension origin and a classic script
      // element of this page (the generated background page carries no CSP that would refuse it).
      pageWindow.importScripts = importScriptsFor({
        origin,
        base: location.href,
        fetchText: (url) => {
          const xhr = new XMLHttpRequest()
          xhr.open('GET', url, false)
          xhr.send()
          return { status: xhr.status, text: xhr.responseText }
        },
        document
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
  if (!first.touch) return
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

  // A page's CSP has no say over an extension's resources in Chrome; over the emulated origin it
  // has. A `<script src=<extension origin>/…>` the page's `script-src` refused runs in the main
  // world through the host instead (`extensionScriptRecovery.ts`).
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
    error: primordials.error
  })
  const recovery = scriptRecovery
  window.addEventListener('error', (event) => recovery.onError(event), true)
  const builtins = collectBuiltins(realWindow)
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
        trustedTypes: null
      }
    : null
  if (stats)
    Object.defineProperty(g, '__zenExtStats', {
      value: stats,
      enumerable: false,
      configurable: true
    })

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
  }
  const scopes = new Map<string, Scope>()

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
        isolation
      }
      scopes.set(key, scope)
      return scope
    }
    const messaging = unit.messaging
    let root: Any
    if (isolation === 'world') {
      shieldWorld(ext, 'world')
      root = realWindow
    } else {
      shieldWorld(ext, 'with')
      root = createScopeProxy(realWindow, builtins)
      // A module the content script imports evaluates on the real global, not in the proxy's
      // scope: the host brackets the served module text, and this accessor answers the
      // extension's `chrome` there while the module's body runs (extensionModuleChrome.ts).
      installModuleChrome(realWindow, (id) => scopes.get(`${id}/with/content`)?.chrome)
    }
    // A user-script world without `configureWorld({ messaging: true })` has no `chrome` at all.
    const engine = messaging ? makeEngine(ext, context, frame, root, isolation === 'world') : null
    scope = {
      ext,
      engine,
      window: root,
      chrome: engine ? engine.chrome : undefined,
      browser: engine ? (root.browser ?? engine.chrome) : undefined,
      isolation
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
      if (text !== undefined) injectCss(key, text)
    }
    const fn = sources[`${scope.ext.id}/${group.index}`]
    if (fn) {
      const w = scope.window
      try {
        fn.call(w, w, w, w, scope.chrome, scope.browser)
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
      world?: unknown
    }
    const scope = scopeFor(ext, options.world === 'MAIN' ? 'none' : ext.isolation, contentUnit)
    if (kind === 'css') {
      const key = `${ext.id}/#${String(options.id ?? options.code ?? '')}`
      if (options.remove) removeCss(key)
      else injectCss(key, String(options.code ?? ''))
      return null
    }
    if (typeof fn !== 'function') throw new Error('no script')
    const w = scope.window
    return (fn as GroupFunction).call(w, w, w, w, scope.chrome, scope.browser)
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
