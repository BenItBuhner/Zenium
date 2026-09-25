import { extensionOrigin } from '@core/extensions/runtime/plan'
import { pageAliasUrl, presentExtensionUrl } from '@core/extensions/runtime/extensionUrls'

/**
 * Extension-origin scripts and stylesheets under the page's Content-Security-Policy.
 *
 * A content script may insert `<script src="chrome.runtime.getURL('x.js')">` or
 * `<link rel="stylesheet" href="chrome.runtime.getURL('x.css')">` into any page: in Chrome an
 * extension's resources are beyond the page's policy (`chrome-extension:` bypasses CSP). The
 * emulated origin, `https://<id>.ext.zenium.invalid`, is an https origin a page's `script-src`
 * or `style-src` refuses like any other, and then the element fires `error` and never runs or
 * applies.
 *
 * The bootstrap listens for that `error` (capture, on the window: `error` does not bubble) in
 * every world that runs an extension's scripts. An element under an attached extension's
 * origin is recovered:
 *
 * - a `<script>` is reported to the host, which runs the file in the main world itself
 *   (`evaluateJavascript` is under no page policy) and answers;
 * - a stylesheet `<link>` is read through the extension's own fetch (the relay's, past the
 *   page's `connect-src`), its relative `url()` references made absolute, and adopted as a
 *   constructed sheet of the document (`document.adoptedStyleSheets`, which no `style-src`
 *   governs, the way Chrome's extension sheets are beyond it).
 *
 * While the host takes the load over, the element's `src` / `href` attribute is re-spelled as
 * Chrome spells it, `chrome-extension://<id>/x.js`: a script has already started, so its
 * attribute changes nothing about loading, and a script that looks itself up by it (Language
 * Reactor's `script[data-lr-nonce][src*="extension://"]`) finds what it finds in Chrome. The
 * element then gets the `load` it expected, or, when the recovery could not (not web-accessible,
 * a subframe, no such file), the attribute back and the `error` it was already firing. The
 * refusal never reaches the extension's own handlers. A stylesheet `<link>` fetches again each
 * time its href changes, and those loads fail as the first did (the page's policy refuses
 * `chrome-extension:` too, and the WebView has no such scheme): their `error`s are the
 * recovery's to swallow, so that the element's own listeners get the verdict alone – Vite's
 * preload helper rejects a whole module graph on the first `error` of a CSS dependency's
 * `<link>` (Buyhatke's content app on flipkart.com, whose `style-src` refuses the served origin:
 * the respelled href's refusal reached the helper 3 ms after the first, ahead of the sheet read
 * through the relay, and the app never mounted; compat round 18).
 *
 * A module graph a content script `import()`s has no element: the page's `script-src` refuses
 * the fetch itself (Buyhatke's CRXJS loaders on flipkart.com, `script-src 'nonce-…'`, compat
 * round 9, row 7), the promise rejects, and the only trace is the document's
 * `securitypolicyviolation` event, which the bootstrap also hands here (`onViolation`). A
 * request carries the nonce of the script that made it, and a nonce the policy names lets the
 * request through, so on a WebView without isolated worlds, where the module would evaluate on
 * the page's real global anyway and the host's bracket gives it the extension's `chrome` there
 * (`extensionModuleChrome.ts`), the graph is fetched again by a `<script type="module">` of the
 * document's carrying the page's own nonce (read from its nonced elements: the `nonce` IDL
 * attribute keeps what the content attribute hides): its `import` descendants inherit the
 * nonce, and the graph evaluates as the content script's `import()` would have had it. The
 * loader's own promise stays rejected, which Buyhatke's (`onExecute?.()` on a module that
 * exports none) never minds.
 *
 * A policy that lends no nonce but admits the page's own origin (`script-src 'self' …`: Steam's,
 * where Eneba's CRXJS loader imports its widget chunk, compat rounds 14-16) refuses the served
 * origin and nothing else of ours, so the graph is asked for again from the page's own origin,
 * `<page origin>/.zenium-ext/<id>/<path>` (`pageAliasUrl`), which the host serves in
 * `shouldInterceptRequest` as it serves the extension's origin (the web-accessible resources
 * only, subresources only). In an isolated world (Chromium 146+) the retry is the world's own
 * `import()` of the alias (`importModule`), so the graph evaluates in the world beside the
 * content script's `chrome`, as Chrome's would have; on the one-realm WebView the alias goes
 * into the module `<script>` in the nonce's place, bracketed by the host as the served graph is.
 * A page whose nonced scripts serve another directive while its `script-src` names hosts alone
 * (YouTube's `'self' https://…`, NoteGPT's loader, compat round 17) refuses the nonced module
 * at the served origin as well: that element's `error` asks once more from the alias, the
 * nonce kept, before the refusal is recorded.
 * A policy that names neither a nonce nor the page's origin refuses the alias too (Flipkart's
 * nonce-only `script-src` on an isolated-world WebView, Buyhatke): that refusal is recorded and
 * nothing is retried further – the alias is not an extension URL, so its own violation is not
 * this recovery's.
 *
 * The retry is one hop: the graph is imported again beside the extension's own rejected
 * promise. A graph whose first module imports more by `chrome.runtime.getURL`-built specifiers
 * (Vite's preload helper in a CRXJS build: Buyhatke's on flipkart.com, whose policy admits
 * `'self'`, compat round 16) asks for its chunks at the served origin again, the same policy
 * refuses them, and the helper's own `import()` promises – which its code awaits – stay
 * rejected whether or not the chunks are retried from the alias. So once an isolated world's
 * refused graph was asked for from the alias, `runtime.getURL` of a script file answers the
 * alias in that world (`aliasFor`, the engine's `scriptAlias`): the chunks load where the
 * first module did, the helper's promises resolve, and Chrome's shape holds – an extension URL
 * the page's policy cannot refuse. Only script files change spelling (a page, an image, a
 * fetch keep the served origin; a stylesheet has the `<link>` recovery), and only after the
 * refusal: a world whose page admits the served origin never sees the alias.
 */

/** What the bootstrap lends the recovery: the attached extensions, the bridge and a file read. */
export interface ScriptRecoveryHost {
  /** Ids of the extensions attached to this world at call time. */
  attachedIds(): string[]
  /** Ask the host to run `url` in the main world; it answers through `done(id, error)`. */
  request(id: string, extId: string, url: string): void
  /** Read an extension file's text the way the extension's own `fetch` would (the relay's). */
  readText?(extId: string, url: string): Promise<string>
  error(...args: unknown[]): void
  /** Notices that are not the runtime's failures (a refusal it can only record). */
  warn?(...args: unknown[]): void
  /** The document whose policy refused a module import: where the nonced retry goes. */
  document?: ModuleDocumentLike
  /**
   * Whether a module evaluated on the page's real global finds the extension's `chrome` there
   * (the `with` fallback's bracket): only then is a refused module graph retried from a module
   * script of the page's; in an isolated world it is retried through `importModule`.
   */
  pageModules?: boolean
  /** The page's origin (`location.origin`), the root of the alias a refused graph is asked from again. */
  pageOrigin?: string
  /**
   * The world's own dynamic `import()` (an isolated world's: the graph evaluates beside the
   * content script's `chrome`); without it, or without `pageOrigin`, an isolated world's refusal
   * is recorded and nothing is retried.
   */
  importModule?(url: string): Promise<unknown>
}

/** A `securitypolicyviolation` event, the little of it the recovery reads. */
export interface ViolationEventLike {
  blockedURI?: unknown
  effectiveDirective?: unknown
  violatedDirective?: unknown
  disposition?: unknown
}

/** The document a refused module import is retried in, the little of it the recovery uses. */
export interface ModuleDocumentLike {
  scripts?: ArrayLike<{ src?: unknown; nonce?: unknown }>
  head?: { appendChild(node: object): unknown } | null
  documentElement?: { appendChild(node: object): unknown } | null
  createElement(tag: string): ModuleScriptLike
}

/** The `<script type="module">` the retry inserts. */
export interface ModuleScriptLike extends ScriptLike {
  type?: unknown
  nonce?: unknown
  addEventListener(type: string, listener: () => void): void
  remove?(): void
}

/** The little of a `<script>` / `<link>` element and its `error` event the recovery reads. */
export interface ScriptLike {
  tagName?: unknown
  src?: unknown
  href?: unknown
  rel?: unknown
  ownerDocument?: unknown
  getAttribute?(name: string): string | null
  setAttribute?(name: string, value: string): void
  dispatchEvent(event: Event): boolean
}

export interface ErrorEventLike {
  target: unknown
  stopImmediatePropagation(): void
}

export interface ScriptRecovery {
  /** The window's capturing `error` listener. */
  onError(event: ErrorEventLike): void
  /** The window's capturing `securitypolicyviolation` listener: a refused module import. */
  onViolation(event: ViolationEventLike): void
  /** The host's answer to `request`: `error` null when the file ran in the main world. */
  done(id: string, error: string | null): void
  /** Requests still waiting for the host, and module retries still loading (tests, diagnostics). */
  pending(): number
  /**
   * What `runtime.getURL` answers for `url` (a served extension URL) in this world: its
   * page-origin alias when the world is isolated, the page's policy refused a module of that
   * extension and the alias was asked for it, and `url` is a script file; null otherwise (the
   * served URL stands).
   */
  aliasFor(url: string): string | null
}

/** The directives a refused script fetch is reported under (`script-src-elem` falls back to `script-src`). */
const SCRIPT_DIRECTIVES = new Set(['script-src-elem', 'script-src'])

/** A script file's path (`.js`, `.mjs`, `.cjs`), a query or fragment after it or not. */
const SCRIPT_FILE = /\.[cm]?js(?:[?#]|$)/i

/** The document's constructed-sheet surface the stylesheet recovery uses. */
interface AdoptingDocument {
  adoptedStyleSheets?: CSSStyleSheet[]
  defaultView?: { CSSStyleSheet?: typeof CSSStyleSheet } | null
}

const RECOVERED = new WeakSet<object>()

/** The element whose verdict (`load` or `error`) the recovery is dispatching itself: that one passes `onError`. */
let dispatching: object | null = null

/** The recovery's verdict on an element it took over, dispatched as the event the element was waiting for. */
function verdict(element: ScriptLike, name: 'load' | 'error'): void {
  dispatching = element
  try {
    element.dispatchEvent(new Event(name))
  } finally {
    dispatching = null
  }
}

export function createScriptRecovery(host: ScriptRecoveryHost): ScriptRecovery {
  const waiting = new Map<string, { script: ScriptLike; url: string }>()
  let seq = 0
  let styles = 0

  const extensionFor = (src: string): string | null => {
    for (const id of host.attachedIds()) if (src.startsWith(extensionOrigin(id) + '/')) return id
    return null
  }

  /** The attribute Chrome's DOM would show; back to the served one when the recovery fails. */
  const respell = (element: ScriptLike, attribute: string, value: string): void => {
    try {
      element.setAttribute?.(attribute, value)
    } catch {
      /* a frozen element of the page's: the load is still recovered */
    }
  }

  const recoverScript = (script: ScriptLike, src: string, extId: string): void => {
    const id = `s${(seq += 1)}`
    waiting.set(id, { script, url: src })
    respell(script, 'src', presentExtensionUrl(src))
    host.request(id, extId, src)
  }

  const retried = new Set<string>()
  let modules = 0

  /** The page's own nonce, from any nonced script of the document (the IDL attribute keeps it). */
  const pageNonce = (doc: ModuleDocumentLike): string | null => {
    const scripts = doc.scripts
    if (!scripts) return null
    for (let i = 0; i < scripts.length; i += 1) {
      const nonce = scripts[i]?.nonce
      if (typeof nonce === 'string' && nonce !== '') return nonce
    }
    return null
  }

  /** Whether a `<script>` of the document loads `url` (spelled either way): the element's own recovery. */
  const inScripts = (doc: ModuleDocumentLike, url: string): boolean => {
    const scripts = doc.scripts
    if (!scripts) return false
    const shown = presentExtensionUrl(url)
    for (let i = 0; i < scripts.length; i += 1) {
      const src = scripts[i]?.src
      if (src === url || src === shown) return true
    }
    return false
  }

  /** The page-origin alias of a refused module's URL, or null when the page lends no origin to root it under. */
  const aliasOf = (url: string): string | null =>
    host.pageOrigin === undefined ? null : pageAliasUrl(host.pageOrigin, url)

  /** An isolated world's retry: the world's own `import()` of the alias, the graph evaluating beside the content script's `chrome`. */
  const importAlias = (
    url: string,
    alias: string,
    importModule: (url: string) => Promise<unknown>
  ): void => {
    modules += 1
    let imported: Promise<unknown>
    try {
      imported = importModule(alias)
    } catch (reason) {
      modules -= 1
      host.error(
        `[Zenium] ${url} could not be retried past the page's policy from its page-origin alias: ${String(reason)}`
      )
      return
    }
    imported.then(
      () => {
        modules -= 1
      },
      (reason: unknown) => {
        modules -= 1
        // The alias refused too (a policy naming neither a nonce nor the page's origin), or the
        // graph itself failed: the extension's loader saw its own rejection; this one is ours to record.
        host.error(
          `[Zenium] ${url} could not load past the page's policy from its page-origin alias ${alias}: ${String(reason)}`
        )
      }
    )
  }

  /** The extensions whose refused graph this isolated world asked for from the alias (`aliasFor`). */
  const aliased = new Set<string>()

  /**
   * The one-realm retry's element: a `<script type="module">` of the document at `src` (the
   * served URL under the page's nonce, or the page-origin alias), `refused` run when the policy
   * refuses that one too.
   */
  const insertModule = (
    doc: ModuleDocumentLike,
    url: string,
    src: string,
    nonce: string | null,
    refused: () => void
  ): void => {
    let element: ModuleScriptLike
    try {
      element = doc.createElement('script')
      element.type = 'module'
      if (nonce !== null) element.nonce = nonce
      // A Trusted Types sink: an enforcing page without the shield's policy refuses the string.
      element.src = src
    } catch (reason) {
      host.error(`[Zenium] ${url} could not be retried past the page's policy: ${String(reason)}`)
      return
    }
    // Its own `error` is not a classic `<script src>` for the host to run.
    RECOVERED.add(element)
    modules += 1
    const settle = (): void => {
      modules -= 1
      try {
        element.remove?.()
      } catch {
        /* already gone */
      }
    }
    element.addEventListener('load', settle)
    element.addEventListener('error', () => {
      settle()
      refused()
    })
    const parent = doc.head ?? doc.documentElement
    try {
      if (!parent) throw new Error('the document has no element to hold a script')
      parent.appendChild(element)
    } catch (reason) {
      settle()
      host.error(`[Zenium] ${url} could not be retried past the page's policy: ${String(reason)}`)
    }
  }

  const retryModule = (url: string): void => {
    const doc = host.document
    if (!doc) return
    if (!host.pageModules) {
      const alias = aliasOf(url)
      const importModule = host.importModule
      if (alias === null || !importModule) {
        ;(host.warn ?? host.error)(
          `[Zenium] ${url}: the page's policy refused the extension's module, and the isolated world cannot load one past it (recorded)`
        )
        return
      }
      // Before the import: the graph's first module asks for its chunks while it evaluates.
      const extId = extensionFor(url)
      if (extId !== null) aliased.add(extId)
      importAlias(url, alias, importModule)
      return
    }
    const nonce = pageNonce(doc)
    const alias = aliasOf(url)
    if (nonce === null && alias === null) {
      host.error(`[Zenium] ${url} could not load past the page's policy: the page lends no nonce`)
      return
    }
    const fromAlias = (): void => {
      insertModule(doc, url, alias as string, nonce, () => {
        host.error(
          `[Zenium] ${url} could not load past the page's policy from a module script at its page-origin alias ${alias}`
        )
      })
    }
    // No nonce to carry: the graph from the page's own origin, which `'self'` or the page's
    // host admits, in the served URL's place; a policy admitting neither refuses this too and
    // the element's `error` records it.
    if (nonce === null) {
      fromAlias()
      return
    }
    insertModule(doc, url, url, nonce, () => {
      if (alias === null) {
        host.error(
          `[Zenium] ${url} could not load past the page's policy from a module script with its nonce`
        )
        return
      }
      // The page's nonce is not this policy's word: its nonced scripts serve another directive
      // and its `script-src` names hosts alone (YouTube's `'self' https://…` under NoteGPT's
      // loader on a one-realm WebView, compat round 17 row 28). A policy of that shape admits
      // the page's own origin, so the graph is asked for once more from the alias, the nonce
      // kept for a second policy that would want it.
      fromAlias()
    })
  }

  const recoverStyle = (link: ScriptLike, href: string, extId: string): void => {
    const read = host.readText
    if (!read) {
      verdict(link, 'error')
      return
    }
    styles += 1
    respell(link, 'href', presentExtensionUrl(href))
    read(extId, href)
      .then((text) => {
        if (!adoptSheet(link, rebaseCssUrls(text, href)))
          throw new Error('the document takes no constructed stylesheet')
        verdict(link, 'load')
      })
      .catch((reason: unknown) => {
        host.error(
          `[Zenium] ${href} could not be applied past the page's policy: ${String(reason)}`
        )
        respell(link, 'href', href)
        verdict(link, 'error')
      })
      .finally(() => {
        styles -= 1
      })
  }

  return {
    onError(event) {
      const target = event.target as ScriptLike | null
      if (!target || typeof target !== 'object' || typeof target.dispatchEvent !== 'function')
        return
      const tag = String(target.tagName).toUpperCase()
      if (tag !== 'SCRIPT' && tag !== 'LINK') return
      if (RECOVERED.has(target)) {
        // Our own `error`, dispatched after the recovery gave up, goes through. A `<link>` fires
        // another of its own at each respelling of its href (the load the new spelling started,
        // refused as the first was): that one stops here, the element's listeners get the
        // verdict alone.
        if (tag === 'LINK' && dispatching !== target) event.stopImmediatePropagation()
        return
      }
      if (tag === 'LINK') {
        const rel = typeof target.rel === 'string' ? target.rel : ''
        if (!/\bstylesheet\b/i.test(rel)) return
        const href = typeof target.href === 'string' ? target.href : ''
        const extId = extensionFor(href)
        if (extId === null) return
        RECOVERED.add(target)
        event.stopImmediatePropagation()
        recoverStyle(target, href, extId)
        return
      }
      const src = typeof target.src === 'string' ? target.src : ''
      const extId = extensionFor(src)
      if (extId === null) return
      RECOVERED.add(target)
      event.stopImmediatePropagation()
      recoverScript(target, src, extId)
    },
    onViolation(event) {
      if (!event || typeof event !== 'object') return
      // A report-only policy blocks nothing.
      if (event.disposition !== undefined && event.disposition !== 'enforce') return
      const directive = String(event.effectiveDirective || event.violatedDirective || '').split(
        /\s/
      )[0]
      if (!directive || !SCRIPT_DIRECTIVES.has(directive)) return
      const blocked = typeof event.blockedURI === 'string' ? event.blockedURI : ''
      if (extensionFor(blocked) === null) return
      // A `<script src>` of the document (the page's, or this retry's own): the element's `error`
      // is where that one is recovered or given up.
      if (host.document && inScripts(host.document, blocked)) return
      if (retried.has(blocked)) return
      retried.add(blocked)
      retryModule(blocked)
    },
    done(id, error) {
      const entry = waiting.get(id)
      if (!entry) return
      waiting.delete(id)
      if (error === null) {
        verdict(entry.script, 'load')
        return
      }
      host.error(`[Zenium] ${entry.url} could not run in the main world: ${error}`)
      respell(entry.script, 'src', entry.url)
      verdict(entry.script, 'error')
    },
    pending: () => waiting.size + styles + modules,
    aliasFor(url) {
      if (host.pageModules || aliased.size === 0 || !SCRIPT_FILE.test(url)) return null
      const extId = extensionFor(url)
      if (extId === null || !aliased.has(extId)) return null
      return aliasOf(url)
    }
  }
}

/**
 * The sheet's text adopted by the link's document as a constructed stylesheet; false when the
 * document (or its window) has none of that (Chromium before 73), in which case the caller
 * reports the refusal as it stood.
 */
function adoptSheet(link: ScriptLike, css: string): boolean {
  const doc = link.ownerDocument as AdoptingDocument | null | undefined
  const Sheet = doc?.defaultView?.CSSStyleSheet
  if (!doc || typeof Sheet !== 'function' || !Array.isArray(doc.adoptedStyleSheets)) return false
  const sheet = new Sheet()
  if (typeof sheet.replaceSync !== 'function') return false
  sheet.replaceSync(css)
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
  return true
}

/**
 * A constructed sheet resolves its `url()` references against the document, not the file: the
 * relative ones are spelled out against the file's URL (fonts beside a font face, images beside
 * a rule) so they load as the `<link>` would have loaded them. `@import` is dropped by
 * `replaceSync` and stays as it is.
 */
export function rebaseCssUrls(css: string, fileUrl: string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g,
    (whole: string, quote: string, ref: string): string => {
      const trimmed = ref.trim()
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(trimmed)) return whole
      try {
        return `url(${quote}${new URL(trimmed, fileUrl).href}${quote})`
      } catch {
        return whole
      }
    }
  )
}
