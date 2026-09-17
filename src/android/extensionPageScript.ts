import type {
  BootConfig,
  BootGroup,
  ExtensionBoot,
  IsolationMode
} from '@core/extensions/runtime/boot'
import type { ContentScriptDeclaration } from '@core/extensions/runtime/manifest'
import { contentScriptAppliesTo, type FrameContext } from '@core/extensions/runtime/matchPatterns'
import { EXTENSION_ORIGIN_SUFFIX, extensionOrigin } from '@core/extensions/runtime/plan'
import {
  scheduleRunAt,
  type LifecycleHooks,
  type ReadyState
} from '@core/extensions/runtime/scheduling'
import {
  capturePrimordials,
  createChromeShim,
  type ChromeShim,
  type Primordials,
  type ShimContextKind
} from '@core/extensions/runtime/shim'

/**
 * The extension bootstrap Kotlin injects at document start into every tab WebView (content
 * mode) and into background pages, popups and options pages on the fake extension origin (page
 * mode). Kotlin assembles the injected script as
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
 * Kotlin registers one such unit per set of origin rules (`addDocumentStartJavaScript` filters
 * by origin, so an extension matching only youtube.com never travels to other pages). Units of
 * one frame share one transport: the first installs it and exposes `__zenExtRuntime.attach`,
 * which later units call with their boot (token-checked, so the page cannot attach anything).
 *
 * Transport is the WebMessageListener object `__zenExtBridge`: messages go up with
 * `postMessage`, replies come back through its `onmessage` (the frame's JavaScriptReplyProxy).
 * The object is captured and deleted from the global before any page script can see it.
 */
type GroupFunction = (
  this: unknown,
  window: unknown,
  self: unknown,
  globalThis: unknown,
  chrome: unknown,
  browser: unknown
) => void

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

interface GroupStat {
  ext: string
  group: number
  runAt: string
  /** ms since the bootstrap started when the group ran. */
  at: number
  /** ms the group's own code took. */
  ms: number
  /** `document.readyState` and the number of nodes under `<html>` when the group ran. */
  readyState: string
  nodes: number
  error: string | null
}

interface Stats {
  frame: string
  matchMs: number
  bootMs: number
  applied: number
  groups: GroupStat[]
}

interface Runtime {
  attach(boot: Boot): void
}

declare const __zenExtBoot: Boot

;(() => {
  const t0 = performance.now()
  const boot = __zenExtBoot
  const g = globalThis as typeof globalThis & { __zenExtBridge?: Bridge; __zenExtRuntime?: Runtime }
  const installed = g.__zenExtRuntime
  if (installed) {
    installed.attach(boot)
    return
  }

  // --- transport ---------------------------------------------------------------------------------
  const bridge = g.__zenExtBridge
  if (!bridge) return
  const sources: Record<string, GroupFunction> = Object.assign(
    Object.create(null) as Record<string, GroupFunction>,
    boot.sources
  )
  const cssTexts: Record<string, string> = Object.assign(
    Object.create(null) as Record<string, string>,
    boot.css
  )
  const attached: ExtensionBoot[] = []
  const rawPost = bridge.postMessage
  const post = (message: string): void => rawPost.call(bridge, message)
  const primordials: Primordials = capturePrimordials()
  const shims = new Map<string, ChromeShim>()
  const onBridgeMessage = (event: { data: string }): void => {
    let message: Record<string, unknown>
    try {
      message = primordials.parse(event.data) as Record<string, unknown>
    } catch {
      return
    }
    const shim = shims.get(String(message.ep))
    if (shim) shim.receive(message)
  }
  if (bridge.addEventListener) bridge.addEventListener('message', onBridgeMessage)
  else bridge.onmessage = onBridgeMessage
  try {
    delete g.__zenExtBridge
  } catch {
    /* leave it; the object only carries JSON */
  }

  const nonce = Math.random().toString(36).slice(2, 10) + (Date.now() % 1e6).toString(36)
  /**
   * Kotlin drops a frame's endpoints when its main frame says hello for a different document. One
   * document can run several units, each with its own copy of this script (one per origin-rule set
   * that matches, and with real isolated worlds one per extension plus the main-world unit), so the
   * id has to come from the document: `performance.timeOrigin` is the navigation start, identical
   * in every world of the frame and different for every navigation.
   */
  const docId =
    typeof performance === 'object' && performance && performance.timeOrigin > 0
      ? Math.round(performance.timeOrigin).toString(36)
      : nonce
  const endpointIdFor = (ext: ExtensionBoot): string => `${docId}.${nonce}.${ext.id.slice(0, 8)}`
  const realWindow = window

  // --- isolation ---------------------------------------------------------------------------------

  /**
   * The global's own keys and its prototype chain's at document start: everything the browser
   * defines. A key the page adds later is a page global, which an isolated world would not see.
   */
  const builtins = new Set<PropertyKey>()
  {
    let obj: object | null = realWindow
    while (obj) {
      for (const key of Reflect.ownKeys(obj)) builtins.add(key)
      obj = Object.getPrototypeOf(obj)
    }
  }

  /**
   * A per-extension stand-in for `window`/`self`/`globalThis`: expandos land in a private store
   * and never reach the page, reads of browser globals fall through to the real window with
   * native methods bound so `window.setTimeout(...)` keeps working, page globals read as
   * undefined, event handler and other setter properties are forwarded. In `with` mode the same
   * object is the scope object of the group function, so a bare `forTrusted(...)` finds the
   * `globalThis.forTrusted = ...` another file wrote (Vimium's pattern); `has` answers for the
   * store and the browser's globals only, so `'IntersectionObserver' in window` stays honest and
   * undeclared identifiers still throw.
   */
  function shadowWindow(
    chrome: Record<string, unknown>,
    mode: IsolationMode
  ): Record<string, unknown> {
    if (mode === 'none') return realWindow as unknown as Record<string, unknown>
    if (mode === 'world') {
      // This script already runs in the extension's own isolated world: its global is the
      // content scripts' window, exactly as in Chrome, and `chrome` simply lives on it.
      const world = realWindow as unknown as Record<string, unknown>
      world.chrome = chrome
      world.browser = chrome
      return world
    }
    const store: Record<PropertyKey, unknown> = Object.create(null)
    const bound = new Map<PropertyKey, unknown>()
    const target = Object.create(Object.getPrototypeOf(realWindow) as object) as Record<
      PropertyKey,
      unknown
    >
    const win = realWindow as unknown as Record<PropertyKey, unknown>
    const findSetter = (key: PropertyKey): boolean => {
      let obj: object | null = win
      while (obj) {
        const desc = Object.getOwnPropertyDescriptor(obj, key)
        if (desc) return typeof desc.set === 'function'
        obj = Object.getPrototypeOf(obj)
      }
      return false
    }
    const proxy: Record<string, unknown> = new Proxy(target, {
      get(_t, key) {
        if (key in store) return store[key]
        if (key === 'window' || key === 'self' || key === 'globalThis' || key === 'frames')
          return proxy
        if (key === 'chrome' || key === 'browser') return chrome
        if (!builtins.has(key)) return undefined
        const value = win[key]
        if (typeof value === 'function' && typeof key === 'string') {
          const fn = value as { prototype?: unknown }
          // Methods (no `prototype`, lower-case name) need `this === window`; constructors must keep identity.
          if (!('prototype' in fn) && key[0] === key[0].toLowerCase()) {
            let b = bound.get(key)
            if (!b) {
              b = (value as (...a: unknown[]) => unknown).bind(realWindow)
              bound.set(key, b)
            }
            return b
          }
        }
        return value
      },
      set(_t, key, value) {
        if (!(key in store) && builtins.has(key) && findSetter(key)) {
          win[key] = value
          return true
        }
        store[key] = value
        return true
      },
      has(_t, key) {
        return key in store || builtins.has(key)
      },
      deleteProperty(_t, key) {
        delete store[key]
        return true
      },
      defineProperty(_t, key, descriptor) {
        Object.defineProperty(store, key, descriptor)
        return true
      },
      getOwnPropertyDescriptor(_t, key) {
        const own = Object.getOwnPropertyDescriptor(store, key)
        if (own) return own
        if (!builtins.has(key)) return undefined
        const real = Object.getOwnPropertyDescriptor(win, key)
        return real ? { ...real, configurable: true } : undefined
      },
      ownKeys() {
        const keys = new Set<string | symbol>()
        for (const key of Reflect.ownKeys(win)) if (builtins.has(key)) keys.add(key)
        for (const key of Reflect.ownKeys(store)) keys.add(key)
        return [...keys]
      }
    })
    return proxy
  }

  const transport = { post }

  function makeShim(ext: ExtensionBoot, context: ShimContextKind, frame: FrameContext): ChromeShim {
    const endpointId = endpointIdFor(ext)
    const shim = createChromeShim(
      {
        id: ext.id,
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
        world: ext.isolation === 'world'
      },
      transport,
      primordials
    )
    shims.set(endpointId, shim)
    return shim
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

  // --- per-extension scopes (content mode) -----------------------------------------------------

  interface Scope {
    ext: ExtensionBoot
    shim: ChromeShim
    window: Record<string, unknown>
  }
  const scopes = new Map<string, Scope>()

  function scopeFor(ext: ExtensionBoot, frame: FrameContext, context: ShimContextKind): Scope {
    let scope = scopes.get(ext.id)
    if (scope) return scope
    const shim = makeShim(ext, context, frame)
    scope = { ext, shim, window: shadowWindow(shim.chrome, ext.isolation) }
    scopes.set(ext.id, scope)
    return scope
  }

  function runGroup(scope: Scope, group: BootGroup, stats: Stats | null): void {
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
      const w = group.world === 'MAIN' ? realWindow : scope.window
      try {
        fn.call(w, w, w, w, scope.shim.chrome, scope.shim.chrome)
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
   * `scripting.executeScript` / `insertCSS` (main frame only – `evaluateJavascript` reaches no
   * other frame). The JS arrives as a function literal compiled by the WebView's own script
   * execution, so it is never eval'd against the page's CSP; it runs in the extension's scope
   * with its `chrome`. The token is compared, not embedded, so `toString()` reveals nothing.
   */
  function exec(
    token: unknown,
    extId: unknown,
    kind: unknown,
    payload: unknown,
    fn: unknown
  ): unknown {
    if (token !== boot.config.token) throw new Error('bad token')
    const ext = extensions().find((e) => e.id === extId)
    if (!ext) throw new Error('unknown extension')
    const scope = scopeFor(ext, frameContext(), 'content')
    const options = (payload ?? {}) as {
      id?: unknown
      code?: unknown
      remove?: unknown
      world?: unknown
    }
    if (kind === 'css') {
      const key = `${ext.id}/#${String(options.id ?? options.code ?? '')}`
      if (options.remove) removeCss(key)
      else injectCss(key, String(options.code ?? ''))
      return null
    }
    if (typeof fn !== 'function') throw new Error('no script')
    const w = options.world === 'MAIN' ? realWindow : scope.window
    return (fn as GroupFunction).call(w, w, w, w, scope.shim.chrome, scope.shim.chrome)
  }
  Object.defineProperty(g, '__zenExtExec', {
    value: exec,
    writable: false,
    configurable: false,
    enumerable: false
  })

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

  function extensions(): ExtensionBoot[] {
    return boot.config.kind === 'content' ? attached : [boot.config.extension]
  }

  const declarationOf = (group: BootGroup): ContentScriptDeclaration => ({
    matches: group.matches,
    excludeMatches: group.excludeMatches,
    includeGlobs: group.includeGlobs,
    excludeGlobs: group.excludeGlobs,
    js: group.js,
    css: group.css,
    runAt: group.runAt,
    allFrames: group.allFrames,
    matchAboutBlank: group.matchAboutBlank,
    matchOriginAsFallback: group.matchOriginAsFallback,
    world: group.world
  })

  const hooks: LifecycleHooks = {
    readyState: () => document.readyState as ReadyState,
    onDomContentLoaded: (cb) => document.addEventListener('DOMContentLoaded', cb, { once: true }),
    onLoad: (cb) => window.addEventListener('load', cb, { once: true }),
    setTimeout: (cb, ms) => void primordials.setTimeout(cb, ms)
  }

  // --- content mode ------------------------------------------------------------------------------

  if (boot.config.kind === 'content') {
    // Extension pages open as tabs too (options pages, a changelog opened with `tabs.create`);
    // Chrome injects no content scripts into chrome-extension:// documents and neither do we.
    if (location.hostname.endsWith(EXTENSION_ORIGIN_SUFFIX)) return
    const frame = frameContext()
    const stats: Stats | null = boot.debug
      ? { frame: frame.url, matchMs: 0, bootMs: 0, applied: 0, groups: [] }
      : null
    if (stats)
      Object.defineProperty(g, '__zenExtStats', {
        value: stats,
        enumerable: false,
        configurable: true
      })

    /** Match one unit's extensions against this frame and schedule what applies. */
    const apply = (list: ExtensionBoot[], started: number): void => {
      const due: Array<{ ext: ExtensionBoot; group: BootGroup }> = []
      for (const ext of list) {
        attached.push(ext)
        for (const group of ext.groups)
          if (contentScriptAppliesTo(declarationOf(group), frame)) due.push({ ext, group })
      }
      if (stats) stats.matchMs += performance.now() - started
      for (const { ext, group } of due) {
        const scope = scopeFor(ext, frame, 'content')
        scheduleRunAt(group.runAt, hooks, () => runGroup(scope, group, stats))
      }
      if (stats) {
        stats.applied += due.length
        stats.bootMs += performance.now() - started
      }
    }
    apply(boot.config.extensions, t0)

    const runtime: Runtime = {
      attach(other) {
        const t = performance.now()
        if (other.config.token !== boot.config.token || other.config.kind !== 'content') return
        Object.assign(sources, other.sources)
        Object.assign(cssTexts, other.css)
        apply(other.config.extensions, t)
      }
    }
    Object.defineProperty(g, '__zenExtRuntime', {
      value: runtime,
      writable: false,
      configurable: false,
      enumerable: false
    })
    return
  }

  // --- page mode (background page, popup, options, offscreen) ---------------------------------

  const ext = boot.config.extension
  const context = boot.config.context
  const frame = frameContext()
  const shim = makeShim(ext, context, frame)
  const pageWindow = window as unknown as Record<string, unknown>
  pageWindow.chrome = shim.chrome
  pageWindow.browser = shim.chrome

  if (context === 'background') {
    // Service-worker globals the MV3 script expects; `importScripts` is synchronous by contract,
    // so it is a synchronous XHR to the extension origin plus an indirect eval (the generated
    // background page is served with 'unsafe-eval' in its CSP for exactly this).
    const origin = extensionOrigin(ext.id)
    pageWindow.importScripts = (...urls: string[]): void => {
      for (const url of urls) {
        const absolute = new URL(url, location.href).href
        if (!absolute.startsWith(origin + '/'))
          throw new Error(`importScripts: ${url} is not on the extension origin`)
        const xhr = new XMLHttpRequest()
        xhr.open('GET', absolute, false)
        xhr.send()
        if (xhr.status !== 200) throw new Error(`importScripts: ${url} failed (${xhr.status})`)
        const indirectEval = eval
        indirectEval(xhr.responseText + `\n//# sourceURL=${absolute}`)
      }
    }
    pageWindow.skipWaiting = (): Promise<void> => Promise.resolve()
    pageWindow.clients = {
      claim: (): Promise<void> => Promise.resolve(),
      matchAll: (): Promise<never[]> => Promise.resolve([])
    }
    pageWindow.registration = {
      scope: origin + '/',
      active: null,
      installing: null,
      waiting: null,
      unregister: (): Promise<boolean> => Promise.resolve(true)
    }
    pageWindow.serviceWorker = { state: 'activated', scriptURL: location.href }
  }

  if (context === 'popup') {
    // Chrome closes the popup on window.close(); the host owns the sheet.
    pageWindow.close = (): void =>
      post(
        primordials.stringify({
          t: 'closePopup',
          token: boot.config.token,
          ep: endpointIdFor(ext)
        })
      )
    const report = (): void => {
      const root = document.documentElement
      const body = document.body
      const width = Math.max(root.scrollWidth, body ? body.scrollWidth : 0)
      const height = Math.max(root.scrollHeight, body ? body.scrollHeight : 0)
      post(
        primordials.stringify({
          t: 'popupSize',
          token: boot.config.token,
          ep: endpointIdFor(ext),
          width,
          height
        })
      )
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

  window.addEventListener('load', () => shim.ready(), { once: true })
})()
