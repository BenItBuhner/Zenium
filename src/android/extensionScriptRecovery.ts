import { extensionOrigin } from '@core/extensions/runtime/plan'
import { presentExtensionUrl } from '@core/extensions/runtime/extensionUrls'

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
 * Chrome spells it, `chrome-extension://<id>/x.js`: the element has already started, so the
 * attribute changes nothing about loading, and a script that looks itself up by it (Language
 * Reactor's `script[data-lr-nonce][src*="extension://"]`) finds what it finds in Chrome. The
 * element then gets the `load` it expected, or, when the recovery could not (not web-accessible,
 * a subframe, no such file), the attribute back and the `error` it was already firing. The
 * refusal never reaches the extension's own handlers.
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
 * exports none) never minds. In an isolated world the module would evaluate in the world, whose
 * policy is the document's on a WebView, and a module of the page's world would find no
 * `chrome`: there the refusal is recorded and nothing is retried.
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
   * script of the page's; in an isolated world the refusal is recorded instead.
   */
  pageModules?: boolean
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
}

/** The directives a refused script fetch is reported under (`script-src-elem` falls back to `script-src`). */
const SCRIPT_DIRECTIVES = new Set(['script-src-elem', 'script-src'])

/** The document's constructed-sheet surface the stylesheet recovery uses. */
interface AdoptingDocument {
  adoptedStyleSheets?: CSSStyleSheet[]
  defaultView?: { CSSStyleSheet?: typeof CSSStyleSheet } | null
}

const RECOVERED = new WeakSet<object>()

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

  const retryModule = (url: string): void => {
    const doc = host.document
    if (!doc) return
    if (!host.pageModules) {
      ;(host.warn ?? host.error)(
        `[Zenium] ${url}: the page's policy refused the extension's module, and the isolated world cannot load one past it (recorded)`
      )
      return
    }
    const nonce = pageNonce(doc)
    if (nonce === null) {
      host.error(`[Zenium] ${url} could not load past the page's policy: the page lends no nonce`)
      return
    }
    let element: ModuleScriptLike
    try {
      element = doc.createElement('script')
      element.type = 'module'
      element.nonce = nonce
      // A Trusted Types sink: an enforcing page without the shield's policy refuses the string.
      element.src = url
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
      host.error(
        `[Zenium] ${url} could not load past the page's policy from a module script with its nonce`
      )
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

  const recoverStyle = (link: ScriptLike, href: string, extId: string): void => {
    const read = host.readText
    if (!read) {
      link.dispatchEvent(new Event('error'))
      return
    }
    styles += 1
    respell(link, 'href', presentExtensionUrl(href))
    read(extId, href)
      .then((text) => {
        if (!adoptSheet(link, rebaseCssUrls(text, href)))
          throw new Error('the document takes no constructed stylesheet')
        link.dispatchEvent(new Event('load'))
      })
      .catch((reason: unknown) => {
        host.error(
          `[Zenium] ${href} could not be applied past the page's policy: ${String(reason)}`
        )
        respell(link, 'href', href)
        link.dispatchEvent(new Event('error'))
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
      // Our own `error`, re-dispatched after the recovery gave up: let it through this time.
      if (RECOVERED.has(target)) return
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
        entry.script.dispatchEvent(new Event('load'))
        return
      }
      host.error(`[Zenium] ${entry.url} could not run in the main world: ${error}`)
      respell(entry.script, 'src', entry.url)
      entry.script.dispatchEvent(new Event('error'))
    },
    pending: () => waiting.size + styles + modules
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
